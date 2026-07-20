import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FlaskConical, GitBranch } from "lucide-react";
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
import { MetricChart } from "@/components/MetricChart";
import { HypothesisTreeMap } from "@/components/research/HypothesisTreeMap";
import { ResearchTrajectoryChart } from "@/components/research/ResearchTrajectoryChart";
import { ResearchSynthesis } from "@/components/research/ResearchSynthesis";
import { SessionExperimentTree } from "@/components/research/SessionExperimentTree";
import { formatScalar, runDuration, shortHash } from "@/lib/format";
import {
  bestRun,
  better,
  objectiveValue,
  researchAnalyses,
  researchSessionKey,
  researchSessionsFrom,
  researchTrajectory,
  type ResearchCampaign,
  type ResearchRun,
} from "@/lib/research";

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
          <dd className="break-all text-right font-mono tabular-nums">{formatScalar(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function campaignBest(campaign: ResearchCampaign): number | null {
  const selected = bestRun(campaign);
  return selected === null ? null : objectiveValue(selected);
}

function CampaignPhases({
  campaigns,
  selectedKey,
  onSelect,
}: {
  campaigns: readonly ResearchCampaign[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
        <div>
          <CardTitle className="text-sm">Campaign phases</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            One research run; each phase keeps its own objective and candidate tree.
          </p>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {campaigns.length} total
        </span>
      </CardHeader>
      <CardContent className="overflow-x-auto pb-3">
        <div className="flex min-w-max gap-2">
          {campaigns.map((campaign, index) => {
            const selected = campaign.key === selectedKey;
            const evaluated = campaign.runs.filter((run) => objectiveValue(run) !== null).length;
            const running = campaign.runs.some((run) => run.state === "running");
            const best = campaignBest(campaign);
            return (
              <button
                key={campaign.key}
                type="button"
                onClick={() => onSelect(campaign.key)}
                aria-pressed={selected}
                className={cn(
                  "w-64 rounded-md border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "border-primary bg-accent",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    phase {index + 1}
                  </span>
                  {running ? <StatusDot tone="live" label="running" /> : null}
                </div>
                <div className="mt-1 truncate text-xs font-medium" title={campaign.name}>
                  {campaign.name}
                </div>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {campaign.objectiveName}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {best === null ? "—" : formatScalar(best)}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {evaluated}/{campaign.runs.length} evaluated
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function ResearchRunPage() {
  const { project: projectParam = "", sessionName: sessionParam = "" } = useParams();
  const [selectedCampaignKey, setSelectedCampaignKey] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const runsQuery = useQuery({
    queryKey: ["research-runs"],
    queryFn: () => waddleApi.listRuns({ jobType: "autoresearch", limit: 1000 }),
    refetchInterval: 5000,
  });
  const sessions = useMemo(() => researchSessionsFrom(runsQuery.data ?? []), [runsQuery.data]);
  const session = sessions.find(
    (item) => item.key === researchSessionKey(projectParam, sessionParam),
  );
  const trajectory = useMemo(() => (session ? researchTrajectory(session) : []), [session]);
  const sessionOutcomes = useMemo(
    () =>
      session?.campaigns.flatMap((item) => [...researchAnalyses(item).values()]) ?? [],
    [session],
  );

  useEffect(() => {
    if (!session || session.campaigns.length === 0) return;
    if (!session.campaigns.some((campaign) => campaign.key === selectedCampaignKey)) {
      setSelectedCampaignKey(session.campaigns[session.campaigns.length - 1].key);
    }
  }, [selectedCampaignKey, session]);

  const campaign =
    session?.campaigns.find((item) => item.key === selectedCampaignKey) ??
    session?.campaigns[session.campaigns.length - 1];
  const incumbent = useMemo(() => {
    if (!campaign) return { points: [], bestRun: null as ResearchRun | null };
    const analyses = researchAnalyses(campaign);
    let bestValue: number | null = null;
    let selected: ResearchRun | null = null;
    const points: { step: number; value: number }[] = [];
    for (const run of campaign.runs) {
      const value = objectiveValue(run);
      const verdict = analyses.get(run.run_id)?.verdict;
      const accepted = verdict === "baseline" || verdict === "kept";
      if (
        accepted &&
        value !== null &&
        (bestValue === null || better(campaign.goal, value, bestValue))
      ) {
        bestValue = value;
        selected = run;
      }
      if (bestValue !== null) points.push({ step: run.research.trial_index, value: bestValue });
    }
    return { points, bestRun: selected };
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
        title="Couldn't load this research run"
        hint={(runsQuery.error as Error).message}
      />
    );
  }
  if (!runsQuery.isLoading && !session) {
    return (
      <EmptyState
        icon={<GitBranch />}
        title="Research run not found"
        hint="The session may not have synced yet, or the route names a different project."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/research">Back to research runs</Link>
          </Button>
        }
      />
    );
  }
  if (!session || !campaign) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/20" />;
  }

  const selectedRun = campaign.runs.find((run) => run.run_id === selectedRunId) ?? null;
  const selectedAnalysis = selectedRun
    ? researchAnalyses(campaign).get(selectedRun.run_id)
    : undefined;
  const candidatePoints = campaign.runs.flatMap((run) => {
    const value = objectiveValue(run);
    return value === null ? [] : [{ step: run.research.trial_index, value }];
  });
  const baseline = objectiveValue(campaign.runs[0]);
  const best = incumbent.bestRun === null ? null : objectiveValue(incumbent.bestRun);
  const improvement =
    baseline !== null && best !== null && Math.abs(baseline) > 0
      ? ((campaign.goal === "minimize" ? baseline - best : best - baseline) /
          Math.abs(baseline)) *
        100
      : null;
  const evaluated = campaign.runs.filter((run) => objectiveValue(run) !== null).length;
  const running = campaign.runs.filter((run) => run.state === "running").length;
  const workingIdeas = sessionOutcomes.filter((outcome) => outcome.verdict === "kept").length;
  const discardedIdeas = sessionOutcomes.filter(
    (outcome) => outcome.verdict === "discarded" || outcome.verdict === "failed",
  ).length;
  const selectRun = (run: ResearchRun, targetCampaign: ResearchCampaign) => {
    setSelectedCampaignKey(targetCampaign.key);
    setSelectedRunId(run.run_id);
  };
  const subjectLocation = selectedRun?.research.subject_run_id
    ? session.campaigns
        .map((item, phaseIndex) => ({
          campaign: item,
          phaseIndex,
          run: item.runs.find(
            (candidate) => candidate.run_id === selectedRun.research.subject_run_id,
          ),
        }))
        .find((item) => item.run !== undefined)
    : undefined;
  const parentLocation = selectedRun?.research.parent_run_id
    ? session.campaigns
        .map((item, phaseIndex) => ({
          campaign: item,
          phaseIndex,
          run: item.runs.find(
            (candidate) => candidate.run_id === selectedRun.research.parent_run_id,
          ),
        }))
        .find((item) => item.run !== undefined)
    : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link to="/research">
            <ArrowLeft className="h-4 w-4" /> Research runs
          </Link>
        </Button>
        <PageHeader
          title={session.name}
          description={`${session.campaigns.length} campaign phases and ${session.runs.length} candidate trials in ${session.project} over ${runDuration(session.startedAt, session.updatedAt)}.`}
          actions={
            <Select value={campaign.key} onValueChange={setSelectedCampaignKey}>
              <SelectTrigger className="h-9 w-[min(26rem,70vw)] text-sm">
                <SelectValue placeholder="Choose a campaign phase" />
              </SelectTrigger>
              <SelectContent>
                {session.campaigns.map((item, index) => (
                  <SelectItem key={item.key} value={item.key}>
                    {index + 1}. {item.name} · {item.objectiveName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiStat label="Campaign phases" value={String(session.campaigns.length)} />
        <KpiStat label="Candidate trials" value={String(session.runs.length)} />
        <KpiStat label="Working ideas" value={String(workingIdeas)} />
        <KpiStat label="Discarded / failed" value={String(discardedIdeas)} />
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 py-3">
          <div>
            <CardTitle className="text-sm">Unified score trajectory</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Every attempt remains visible as scatter; only accepted, gate-valid improvements
              form the running-best staircase. Scores are direction-normalized per phase.
            </p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">
            {trajectory.length} phases
          </Badge>
        </CardHeader>
        <CardContent>
          {trajectory.length === 0 ? (
            <div className="grid h-[220px] place-items-center text-sm text-muted-foreground">
              Waiting for the first comparable score…
            </div>
          ) : (
            <ResearchTrajectoryChart
              phases={trajectory}
              selectedRunId={selectedRunId}
              onSelect={selectRun}
            />
          )}
        </CardContent>
      </Card>

      <HypothesisTreeMap
        session={session}
        selectedRunId={selectedRunId}
        onSelect={selectRun}
      />

      <ResearchSynthesis session={session} onSelect={selectRun} />

      <CampaignPhases
        campaigns={session.campaigns}
        selectedKey={campaign.key}
        onSelect={setSelectedCampaignKey}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiStat label="Phase baseline" value={baseline === null ? "—" : formatScalar(baseline)} />
        <KpiStat label="Phase best" value={best === null ? "—" : formatScalar(best)} />
        <KpiStat
          label="Improvement"
          value={
            improvement === null
              ? "—"
              : `${improvement >= 0 ? "+" : ""}${improvement.toFixed(2)}%`
          }
        />
        <KpiStat label="Phase evaluated" value={`${evaluated} / ${campaign.runs.length}`} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
          <div>
            <CardTitle className="font-mono text-sm">{campaign.objectiveName}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Candidate score and cumulative {campaign.goal === "minimize" ? "minimum" : "maximum"}
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
              {campaign.goal}
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
        <SessionExperimentTree
          session={session}
          selectedRunId={selectedRunId}
          onSelect={selectRun}
        />

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
                <section className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Idea outcome
                    </h2>
                    {selectedAnalysis ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[10px] uppercase",
                          selectedAnalysis.verdict === "kept" &&
                            "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400",
                          selectedAnalysis.verdict === "baseline" &&
                            "border-blue-600/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
                          selectedAnalysis.verdict === "failed" &&
                            "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400",
                        )}
                      >
                        {selectedAnalysis.verdict}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-3 grid gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Why it might work
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">
                        {selectedRun.research.hypothesis}
                      </p>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        What the evidence says
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">
                        {selectedAnalysis?.evidence ?? "No derived evidence summary is available."}
                      </p>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Conclusion
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">
                        {selectedAnalysis?.conclusion ?? "No conclusion recorded."}
                      </p>
                    </div>
                    {selectedAnalysis && selectedAnalysis.failedGates.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedAnalysis.failedGates.map((gate) => (
                          <Badge key={gate} variant="destructive" className="font-mono text-[9px]">
                            {gate}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
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
                      {selectedRun.commit_sha
                        ? shortHash(selectedRun.commit_sha, 12)
                        : "uncommitted"}
                    </div>
                  </div>
                </div>
                <section>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Relation
                  </h2>
                  <div className="flex flex-col items-start gap-1.5">
                    {selectedRun.research.parent_run_id ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (parentLocation?.run) {
                            selectRun(parentLocation.run, parentLocation.campaign);
                          }
                        }}
                        className="font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        parent ·{" "}
                        {parentLocation?.run
                          ? `phase ${parentLocation.phaseIndex + 1} / trial ${parentLocation.run.research.trial_index}`
                          : shortHash(selectedRun.research.parent_run_id, 12)}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">campaign root</span>
                    )}
                    {selectedRun.research.subject_run_id ? (
                      subjectLocation?.run ? (
                        <button
                          type="button"
                          onClick={() => selectRun(subjectLocation.run!, subjectLocation.campaign)}
                          className="font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          evaluates · phase {subjectLocation.phaseIndex + 1} / trial{" "}
                          {subjectLocation.run.research.trial_index}
                        </button>
                      ) : (
                        <Link
                          to={`/runs/${selectedRun.research.subject_run_id}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          evaluates · {shortHash(selectedRun.research.subject_run_id, 12)}
                        </Link>
                      )
                    ) : null}
                  </div>
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
