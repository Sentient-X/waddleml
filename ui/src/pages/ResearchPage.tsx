import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FlaskConical, GitBranch } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusDot,
  cn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { ResearchTrial, Run } from "@/api/types";
import { MetricChart } from "@/components/MetricChart";
import { formatScalar, runStateTone, shortHash } from "@/lib/format";

type ResearchRun = Run & { group_name: string; research: ResearchTrial };

interface ResearchCampaign {
  key: string;
  project: string;
  name: string;
  objectiveName: string;
  goal: ResearchTrial["goal"];
  runs: ResearchRun[];
}

interface TreeRow {
  run: ResearchRun;
  depth: number;
  orphan: boolean;
}

function isResearchRun(run: Run): run is ResearchRun {
  return run.group_name !== null && run.research !== null;
}

function campaignKey(project: string, name: string): string {
  return JSON.stringify([project, name]);
}

function objectiveValue(run: ResearchRun): number | null {
  if (run.state !== "completed") return null;
  const value = run.summary[run.research.objective_name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function orderedRuns(runs: readonly ResearchRun[]): ResearchRun[] {
  return [...runs].sort(
    (a, b) =>
      a.research.trial_index - b.research.trial_index ||
      new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );
}

function treeRows(runs: readonly ResearchRun[]): TreeRow[] {
  const ordered = orderedRuns(runs);
  const ids = new Set(ordered.map((run) => run.run_id));
  const children = new Map<string, ResearchRun[]>();
  for (const run of ordered) {
    const parent = run.research.parent_run_id ?? null;
    if (parent !== null && ids.has(parent)) {
      const bucket = children.get(parent) ?? [];
      bucket.push(run);
      children.set(parent, bucket);
    }
  }

  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const visit = (run: ResearchRun, depth: number, orphan: boolean) => {
    if (visited.has(run.run_id)) return;
    visited.add(run.run_id);
    rows.push({ run, depth, orphan });
    for (const child of children.get(run.run_id) ?? []) visit(child, depth + 1, false);
  };
  for (const run of ordered) {
    const parent = run.research.parent_run_id ?? null;
    if (parent === null || !ids.has(parent)) visit(run, 0, parent !== null);
  }
  for (const run of ordered) visit(run, 0, true);
  return rows;
}

function campaignsFrom(runs: readonly Run[]): ResearchCampaign[] {
  const grouped = new Map<string, ResearchRun[]>();
  for (const run of runs) {
    if (!isResearchRun(run)) continue;
    const key = campaignKey(run.project, run.group_name);
    const bucket = grouped.get(key) ?? [];
    bucket.push(run);
    grouped.set(key, bucket);
  }
  return [...grouped.entries()]
    .map(([key, members]) => {
      const runs = orderedRuns(members);
      const first = runs[0];
      return {
        key,
        project: first.project,
        name: first.group_name,
        objectiveName: first.research.objective_name,
        goal: first.research.goal,
        runs,
      };
    })
    .sort((a, b) => {
      const aTime = Math.max(...a.runs.map((run) => new Date(run.started_at).getTime()));
      const bTime = Math.max(...b.runs.map((run) => new Date(run.started_at).getTime()));
      return bTime - aTime;
    });
}

function better(goal: ResearchTrial["goal"], candidate: number, incumbent: number): boolean {
  return goal === "minimize" ? candidate < incumbent : candidate > incumbent;
}

function KeyValues({ values }: { values: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing recorded.</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="break-all font-mono text-right tabular-nums">{formatScalar(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ResearchPage() {
  const [selectedCampaignKey, setSelectedCampaignKey] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const runsQuery = useQuery({
    queryKey: ["research-runs"],
    queryFn: () => waddleApi.listRuns({ jobType: "autoresearch", limit: 1000 }),
    refetchInterval: 5000,
  });
  const campaigns = useMemo(() => campaignsFrom(runsQuery.data ?? []), [runsQuery.data]);

  useEffect(() => {
    if (campaigns.length === 0) return;
    if (!campaigns.some((campaign) => campaign.key === selectedCampaignKey)) {
      setSelectedCampaignKey(campaigns[0].key);
    }
  }, [campaigns, selectedCampaignKey]);

  const campaign = campaigns.find((item) => item.key === selectedCampaignKey) ?? campaigns[0];
  const incumbent = useMemo(() => {
    if (!campaign) return { points: [], bestRun: null as ResearchRun | null };
    let bestValue: number | null = null;
    let bestRun: ResearchRun | null = null;
    const points: { step: number; value: number }[] = [];
    for (const run of campaign.runs) {
      const value = objectiveValue(run);
      if (value !== null && (bestValue === null || better(campaign.goal, value, bestValue))) {
        bestValue = value;
        bestRun = run;
      }
      if (bestValue !== null) points.push({ step: run.research.trial_index, value: bestValue });
    }
    return { points, bestRun };
  }, [campaign]);

  useEffect(() => {
    if (!campaign) return;
    if (!campaign.runs.some((run) => run.run_id === selectedRunId)) {
      setSelectedRunId(
        incumbent.bestRun?.run_id ?? campaign.runs[campaign.runs.length - 1]?.run_id ?? "",
      );
    }
  }, [campaign, incumbent.bestRun, selectedRunId]);

  if (runsQuery.isError) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="Couldn't load research campaigns"
        hint={(runsQuery.error as Error).message}
      />
    );
  }
  if (!runsQuery.isLoading && campaigns.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Research"
          description="Live objective progress and candidate lineage for agent-driven optimization."
        />
        <EmptyState
          icon={<GitBranch />}
          title="No research trials yet"
          hint="Start an ordinary Waddle run with a typed ResearchTrial record; the campaign will appear here on the next sync."
        />
      </div>
    );
  }

  const selectedRun = campaign?.runs.find((run) => run.run_id === selectedRunId) ?? null;
  const rows = campaign ? treeRows(campaign.runs) : [];
  const candidatePoints = campaign
    ? campaign.runs.flatMap((run) => {
        const value = objectiveValue(run);
        return value === null ? [] : [{ step: run.research.trial_index, value }];
      })
    : [];
  const baselineRun = campaign?.runs[0] ?? null;
  const baseline = baselineRun === null ? null : objectiveValue(baselineRun);
  const best = incumbent.bestRun === null ? null : objectiveValue(incumbent.bestRun);
  const improvement =
    baseline !== null && best !== null && Math.abs(baseline) > 0
      ? ((campaign?.goal === "minimize" ? baseline - best : best - baseline) /
          Math.abs(baseline)) *
        100
      : null;
  const evaluated = campaign?.runs.filter((run) => objectiveValue(run) !== null).length ?? 0;
  const running = campaign?.runs.filter((run) => run.state === "running").length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Research"
        description="Live objective progress and candidate lineage for agent-driven optimization."
        actions={
          <Select value={campaign?.key ?? ""} onValueChange={setSelectedCampaignKey}>
            <SelectTrigger className="h-9 w-[min(24rem,70vw)] text-sm">
              <SelectValue placeholder="Choose a campaign" />
            </SelectTrigger>
            <SelectContent>
              {campaigns.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.project} · {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiStat label="Baseline" value={baseline === null ? "—" : formatScalar(baseline)} />
        <KpiStat label="Best" value={best === null ? "—" : formatScalar(best)} />
        <KpiStat
          label="Improvement"
          value={improvement === null ? "—" : `${improvement >= 0 ? "+" : ""}${improvement.toFixed(2)}%`}
        />
        <KpiStat label="Evaluated" value={`${evaluated} / ${campaign?.runs.length ?? 0}`} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
          <div>
            <CardTitle className="font-mono text-sm">{campaign?.objectiveName}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Candidate score and cumulative {campaign?.goal === "minimize" ? "minimum" : "maximum"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb]" /> candidate
            </span>
            <span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:inline-flex">
              <span className="h-0.5 w-3 bg-[#f97316]" /> incumbent
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {campaign?.goal}
            </Badge>
            {running > 0 ? <StatusDot tone="live" label={`${running} running`} /> : null}
          </div>
        </CardHeader>
        <CardContent>
          {candidatePoints.length === 0 ? (
            <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">
              Waiting for the first objective value…
            </div>
          ) : (
            <MetricChart
              height={300}
              series={[
                { label: "candidate", points: candidatePoints, kind: "points" },
                { label: "incumbent", points: incumbent.points, kind: "step" },
              ]}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid min-h-[28rem] gap-5 lg:grid-cols-[minmax(19rem,0.8fr)_minmax(0,1.2fr)]">
        <Card className="min-w-0">
          <CardHeader className="py-3">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Experiment tree</span>
              <span className="font-mono text-[10px] font-normal text-muted-foreground">
                {campaign?.runs.length ?? 0} trials
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-[38rem] overflow-auto p-2 pt-0">
            {rows.map(({ run, depth, orphan }) => {
              const value = objectiveValue(run);
              const isBest = run.run_id === incumbent.bestRun?.run_id;
              const selected = run.run_id === selectedRun?.run_id;
              return (
                <button
                  key={run.run_id}
                  type="button"
                  onClick={() => setSelectedRunId(run.run_id)}
                  className={cn(
                    "relative flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left hover:bg-accent/60",
                    selected && "bg-accent",
                  )}
                  style={{ paddingLeft: `${10 + depth * 18}px` }}
                >
                  {depth > 0 ? (
                    <span
                      className="absolute bottom-0 top-0 border-l border-border"
                      style={{ left: `${10 + (depth - 1) * 18}px` }}
                    />
                  ) : null}
                  <StatusDot tone={runStateTone(run.state)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      Step {run.research.trial_index}
                      {isBest ? <Badge className="px-1 py-0 text-[9px]">best</Badge> : null}
                      {orphan ? <Badge variant="outline">orphan</Badge> : null}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {run.research.hypothesis}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums">
                    {value === null ? "—" : formatScalar(value)}
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between space-y-0 py-3">
            <div className="min-w-0">
              <CardTitle className="text-sm">
                {selectedRun ? `Step ${selectedRun.research.trial_index}` : "Trial detail"}
              </CardTitle>
              {selectedRun ? (
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {selectedRun.run_id}
                </p>
              ) : null}
            </div>
            {selectedRun ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/runs/${selectedRun.run_id}`}>
                  Full run <ExternalLink className="ml-1 h-3 w-3" />
                </Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {selectedRun ? (
              <div className="flex flex-col gap-5">
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hypothesis
                  </h2>
                  <p className="text-sm leading-relaxed">{selectedRun.research.hypothesis}</p>
                </section>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Objective
                    </div>
                    <div className="mt-1 font-mono text-lg tabular-nums">
                      {objectiveValue(selectedRun) === null
                        ? "—"
                        : formatScalar(objectiveValue(selectedRun))}
                    </div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Source
                    </div>
                    <div className="mt-1 font-mono text-sm">
                      {selectedRun.commit_sha ? shortHash(selectedRun.commit_sha, 12) : "uncommitted"}
                    </div>
                  </div>
                </div>
                <section>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Relation
                  </h2>
                  {selectedRun.research.parent_run_id ? (
                    <button
                      type="button"
                      onClick={() => setSelectedRunId(selectedRun.research.parent_run_id ?? "")}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      parent · {shortHash(selectedRun.research.parent_run_id, 12)}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">campaign root</span>
                  )}
                </section>
                <div className="grid gap-5 sm:grid-cols-2">
                  <section>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Config
                    </h2>
                    <KeyValues values={selectedRun.config} />
                  </section>
                  <section>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Metrics
                    </h2>
                    <KeyValues values={selectedRun.summary} />
                  </section>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select a trial to inspect it.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
