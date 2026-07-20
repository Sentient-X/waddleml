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
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import { HypothesisTreeMap } from "@/components/research/HypothesisTreeMap";
import { ResearchTrajectoryChart } from "@/components/research/ResearchTrajectoryChart";
import { SessionExperimentTree } from "@/components/research/SessionExperimentTree";
import { formatScalar, runDuration, shortHash } from "@/lib/format";
import {
  bestRun,
  objectiveValue,
  researchAnalyses,
  researchSessionFrom,
  researchTrajectory,
  type ResearchCampaign,
  type ResearchRun,
} from "@/lib/research";

function KeyValues({ values }: { values: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <dl className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="break-all text-right font-mono tabular-nums">{formatScalar(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function MissingFact({ children }: { children: string }) {
  return <p className="mt-1 text-xs italic text-muted-foreground">{children}</p>;
}

function verdictTone(verdict: string): string {
  if (verdict === "keep") return "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400";
  if (verdict === "baseline") return "border-blue-600/40 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  if (verdict === "fail") return "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400";
  if (verdict === "inconclusive") return "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "";
}

function PhaseRail({
  campaigns,
  selectedKey,
  onSelect,
}: {
  campaigns: readonly ResearchCampaign[];
  selectedKey: string;
  onSelect: (campaign: ResearchCampaign) => void;
}) {
  return (
    <nav aria-label="Research phases" className="overflow-x-auto border-y bg-muted/10">
      <div className="flex min-w-max px-1">
        {campaigns.map((campaign, index) => {
          const selected = campaign.key === selectedKey;
          const running = campaign.runs.some((run) => run.state === "running");
          const best = bestRun(campaign);
          return (
            <button
              key={campaign.key}
              type="button"
              onClick={() => onSelect(campaign)}
              aria-current={selected ? "step" : undefined}
              className={cn(
                "flex h-11 max-w-56 items-center gap-2 border-b-2 border-transparent px-3 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected && "border-primary bg-accent/50",
              )}
              title={`${campaign.name} · ${campaign.objectiveName}`}
            >
              <span className="font-mono text-[10px] text-muted-foreground">P{index + 1}</span>
              <span className="max-w-32 truncate text-xs">{campaign.name}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {best ? formatScalar(objectiveValue(best)) : "—"}
              </span>
              {running ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" /> : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function ResearchRunPage() {
  const { project: projectParam = "", sessionName: sessionParam = "" } = useParams();
  const [selectedRunId, setSelectedRunId] = useState("");
  const sessionQuery = useQuery({
    queryKey: ["research-session", projectParam, sessionParam],
    queryFn: () => waddleApi.getResearchSession(projectParam, sessionParam),
    enabled: Boolean(projectParam && sessionParam),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.state === "running") ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const session = useMemo(
    () => researchSessionFrom(projectParam, sessionParam, sessionQuery.data ?? []),
    [projectParam, sessionParam, sessionQuery.data],
  );
  const trajectory = useMemo(() => (session ? researchTrajectory(session) : []), [session]);

  useEffect(() => {
    if (!session || session.runs.length === 0) return;
    if (!session.runs.some((run) => run.run_id === selectedRunId)) {
      const lastCampaign = session.campaigns.at(-1);
      setSelectedRunId(
        (lastCampaign ? bestRun(lastCampaign)?.run_id : undefined) ?? session.runs.at(-1)!.run_id,
      );
    }
  }, [selectedRunId, session]);

  const location = session?.campaigns
    .map((campaign, phaseIndex) => ({
      campaign,
      phaseIndex,
      run: campaign.runs.find((run) => run.run_id === selectedRunId),
    }))
    .find((item) => item.run !== undefined);
  const selectedRun = location?.run ?? null;
  const selectedCampaign = location?.campaign ?? session?.campaigns.at(-1) ?? null;
  const selectedAnalysis =
    selectedRun && selectedCampaign
      ? researchAnalyses(selectedCampaign).get(selectedRun.run_id)
      : undefined;
  const detailQuery = useQuery({
    queryKey: ["run", selectedRunId],
    queryFn: () => waddleApi.getRun(selectedRunId),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 5_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  if (sessionQuery.isError) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="Couldn't load this research run"
        hint={(sessionQuery.error as Error).message}
      />
    );
  }
  if (!sessionQuery.isLoading && !session) {
    return (
      <EmptyState
        icon={<GitBranch />}
        title="Research run not found"
        hint="The session may not have synced yet, or the route names a different project."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/research">Back to research</Link>
          </Button>
        }
      />
    );
  }
  if (!session || !selectedCampaign) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/20" />;
  }

  const selectRun = (run: ResearchRun) => setSelectedRunId(run.run_id);
  const selectCampaign = (campaign: ResearchCampaign) =>
    setSelectedRunId(bestRun(campaign)?.run_id ?? campaign.runs.at(-1)?.run_id ?? "");
  const explicitLearnings = session.runs.filter((run) => run.research_outcome !== null);
  const running = session.runs.filter((run) => run.state === "running").length;
  const parent = selectedRun?.research.parent_run_id
    ? session.runs.find((run) => run.run_id === selectedRun.research.parent_run_id)
    : undefined;
  const subject = selectedRun?.research.subject_run_id
    ? session.runs.find((run) => run.run_id === selectedRun.research.subject_run_id)
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/research"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Research
          </Link>
          <h1 className="truncate text-xl font-semibold tracking-tight">{session.name}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {session.project} · {session.runs.length} trials · {session.campaigns.length} phases ·{" "}
            {runDuration(session.startedAt, session.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {running > 0 ? <StatusDot tone="live" label={`${running} running`} /> : <StatusDot tone="idle" label="complete" />}
          <span>{explicitLearnings.length} controller outcomes</span>
        </div>
      </header>

      <PhaseRail
        campaigns={session.campaigns}
        selectedKey={selectedCampaign.key}
        onSelect={selectCampaign}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 px-4 py-2.5">
          <div>
            <CardTitle className="text-sm">Score trajectory</CardTitle>
            <p className="text-[10px] text-muted-foreground">
              Faint dots are all attempts; the green staircase is the accepted best.
            </p>
          </div>
          <Badge variant="outline" className="font-mono text-[9px]">
            {trajectory.reduce((total, phase) => total + phase.points.length, 0)} evaluated
          </Badge>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0">
          {trajectory.length > 0 ? (
            <ResearchTrajectoryChart
              phases={trajectory}
              selectedRunId={selectedRunId}
              onSelect={(run) => selectRun(run)}
            />
          ) : (
            <div className="grid h-48 place-items-center text-xs text-muted-foreground">
              Waiting for the first objective value…
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="attempts" className="min-w-0">
        <TabsList className="h-8">
          <TabsTrigger value="attempts" className="text-xs">Attempts</TabsTrigger>
          <TabsTrigger value="hypotheses" className="text-xs">Hypothesis tree</TabsTrigger>
          <TabsTrigger value="learnings" className="text-xs">
            Learnings <span className="ml-1 text-[9px] opacity-60">{explicitLearnings.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attempts" className="mt-3">
          <div className="grid min-h-[28rem] gap-3 lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
            <SessionExperimentTree
              session={session}
              selectedRunId={selectedRunId}
              onSelect={(run) => selectRun(run)}
            />

            <Card className="min-w-0">
              <CardHeader className="flex-row items-center justify-between space-y-0 px-4 py-2.5">
                <div className="min-w-0">
                  <CardTitle className="text-sm">
                    {selectedRun ? `P${(location?.phaseIndex ?? 0) + 1} · trial ${selectedRun.research.trial_index}` : "Trial"}
                  </CardTitle>
                  {selectedRun ? (
                    <p className="truncate font-mono text-[9px] text-muted-foreground">
                      {shortHash(selectedRun.run_id, 12)} · {selectedCampaign.objectiveName} = {formatScalar(objectiveValue(selectedRun))}
                    </p>
                  ) : null}
                </div>
                {selectedRun ? (
                  <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Link to={`/runs/${selectedRun.run_id}`}>
                      Raw run <ExternalLink className="ml-1 h-3 w-3" />
                    </Link>
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4 px-4 pb-4 pt-0">
                {selectedRun && selectedAnalysis ? (
                  <>
                    <section className="border-t pt-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Proposal</h2>
                        <Badge variant="outline" className="font-mono text-[9px]">agent input</Badge>
                      </div>
                      <dl className="space-y-3 text-sm">
                        <div>
                          <dt className="text-[10px] uppercase text-muted-foreground">Hypothesis</dt>
                          <dd className="mt-0.5 leading-relaxed">{selectedRun.research.hypothesis}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase text-muted-foreground">Rationale</dt>
                          {selectedRun.research.rationale ? <dd className="mt-0.5 leading-relaxed">{selectedRun.research.rationale}</dd> : <MissingFact>Not recorded by this legacy trial.</MissingFact>}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <dt className="text-[10px] uppercase text-muted-foreground">Expected</dt>
                            {selectedRun.research.expected_outcome ? <dd className="mt-0.5 text-xs leading-relaxed">{selectedRun.research.expected_outcome}</dd> : <MissingFact>Not recorded.</MissingFact>}
                          </div>
                          <div>
                            <dt className="text-[10px] uppercase text-muted-foreground">Falsified when</dt>
                            {selectedRun.research.falsification_criteria ? <dd className="mt-0.5 text-xs leading-relaxed">{selectedRun.research.falsification_criteria}</dd> : <MissingFact>Not recorded.</MissingFact>}
                          </div>
                        </div>
                      </dl>
                    </section>

                    <section className="border-t pt-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Outcome</h2>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className={cn("font-mono text-[9px] uppercase", verdictTone(selectedAnalysis.verdict))}>
                            {selectedAnalysis.verdict}
                          </Badge>
                          <span className="text-[9px] text-muted-foreground">
                            {selectedAnalysis.source === "controller" ? "recorded by controller" : "legacy-derived selection"}
                          </span>
                        </div>
                      </div>
                      {selectedAnalysis.source === "controller" ? (
                        <dl className="space-y-3 text-sm">
                          <div>
                            <dt className="text-[10px] uppercase text-muted-foreground">Evidence</dt>
                            <dd className="mt-0.5 leading-relaxed">{selectedAnalysis.evidence}</dd>
                          </div>
                          <div>
                            <dt className="text-[10px] uppercase text-muted-foreground">Conclusion</dt>
                            <dd className="mt-0.5 leading-relaxed">{selectedAnalysis.conclusion}</dd>
                          </div>
                          {selectedAnalysis.nextStep ? (
                            <div>
                              <dt className="text-[10px] uppercase text-muted-foreground">Next step</dt>
                              <dd className="mt-0.5 leading-relaxed">{selectedAnalysis.nextStep}</dd>
                            </div>
                          ) : null}
                          {selectedAnalysis.failedGates.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {selectedAnalysis.failedGates.map((gate) => <Badge key={gate} variant="destructive" className="font-mono text-[9px]">{gate}</Badge>)}
                            </div>
                          ) : null}
                        </dl>
                      ) : (
                        <MissingFact>
                          No controller-authored evidence or conclusion was recorded. The chart decision uses only terminal state and objective order.
                        </MissingFact>
                      )}
                    </section>

                    <section className="border-t pt-3">
                      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Lineage</h2>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span>parent · {parent ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => selectRun(parent)}>{shortHash(parent.run_id, 10)}</button> : selectedRun.research.parent_run_id ? shortHash(selectedRun.research.parent_run_id, 10) : "root"}</span>
                        {selectedRun.research.subject_run_id ? <span>evaluates · {subject ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => selectRun(subject)}>{shortHash(subject.run_id, 10)}</button> : shortHash(selectedRun.research.subject_run_id, 10)}</span> : null}
                        <span>source · <span className="font-mono">{selectedRun.commit_sha ? shortHash(selectedRun.commit_sha, 10) : "uncommitted"}</span></span>
                      </div>
                    </section>

                    <details className="border-t pt-3 text-xs">
                      <summary className="cursor-pointer select-none text-muted-foreground">Raw config and metrics</summary>
                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <section><h3 className="mb-1 text-[10px] uppercase text-muted-foreground">Config</h3><KeyValues values={detailQuery.data?.config ?? {}} /></section>
                        <section><h3 className="mb-1 text-[10px] uppercase text-muted-foreground">Metrics</h3><KeyValues values={detailQuery.data?.summary ?? {}} /></section>
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="border-t pt-3 text-xs text-muted-foreground">Select an attempt.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="hypotheses" className="mt-3">
          <HypothesisTreeMap
            session={session}
            selectedRunId={selectedRunId}
            onSelect={(run) => selectRun(run)}
          />
        </TabsContent>

        <TabsContent value="learnings" className="mt-3">
          <Card>
            <CardContent className="p-2">
              {explicitLearnings.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No controller-authored outcomes yet. Legacy trials remain visible under Attempts.
                </div>
              ) : (
                <div className="divide-y">
                  {explicitLearnings.map((run) => (
                    <button
                      key={run.run_id}
                      type="button"
                      onClick={() => selectRun(run)}
                      className="grid w-full gap-1 px-2 py-2 text-left hover:bg-accent/50 sm:grid-cols-[7rem_minmax(12rem,0.8fr)_minmax(16rem,1.2fr)]"
                    >
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">{run.research_outcome!.decision} · trial {run.research.trial_index}</span>
                      <span className="truncate text-xs font-medium">{run.research.hypothesis}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{run.research_outcome!.conclusion}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-[10px] text-muted-foreground">
        Live sessions refresh every 5 seconds; completed sessions refresh on focus. Full run data loads only for the selected attempt.
      </p>
    </div>
  );
}
