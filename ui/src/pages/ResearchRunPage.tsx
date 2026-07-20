import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, FlaskConical, GitBranch } from "lucide-react";
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
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import { HypothesisTreeMap } from "@/components/research/HypothesisTreeMap";
import { ResearchListRow } from "@/components/research/ResearchListRow";
import { ResearchTrajectoryChart } from "@/components/research/ResearchTrajectoryChart";
import { SessionExperimentTree } from "@/components/research/SessionExperimentTree";
import { formatScalar, runDuration, shortHash } from "@/lib/format";
import {
  objectiveValue,
  researchAnalyses,
  researchMetricLeaf,
  researchMetricKey,
  researchMetricTree,
  researchMetrics,
  researchSessionFrom,
  researchVerdictLabel,
  type ResearchMetric,
  type ResearchMetricNamespace,
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

function MetricRow({
  metric,
  selectedMetricKey,
  onSelect,
  depth,
}: {
  metric: ResearchMetric;
  selectedMetricKey: string;
  onSelect: (metric: ResearchMetric) => void;
  depth: number;
}) {
  const best = metric.bestPoint;
  return (
    <ResearchListRow
      selected={metric.key === selectedMetricKey}
      onClick={() => onSelect(metric)}
      className="grid grid-cols-[1rem_minmax(0,1fr)_4.5rem] items-center gap-2"
      style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      title={metric.objectiveName}
    >
      <span className="text-muted-foreground">
        {metric.goal === "minimize" ? (
          <ArrowDown className="h-3.5 w-3.5" />
        ) : (
          <ArrowUp className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-[10px] font-medium leading-tight">
          {researchMetricLeaf(metric)}
        </span>
        <span className="block text-[9px] text-muted-foreground">
          {metric.runs.length} attempts · {metric.goal}
        </span>
      </span>
      <span className="text-right font-mono text-[10px] tabular-nums">
        <span className="block">{best ? formatScalar(best.rawValue) : "—"}</span>
        <span className="block text-[8px] text-muted-foreground">best</span>
      </span>
    </ResearchListRow>
  );
}

function metricNamespaceCount(namespace: ResearchMetricNamespace): number {
  return (
    namespace.metrics.length +
    namespace.children.reduce((total, child) => total + metricNamespaceCount(child), 0)
  );
}

function MetricNamespace({
  namespace,
  selectedMetricKey,
  onSelect,
  depth,
}: {
  namespace: ResearchMetricNamespace;
  selectedMetricKey: string;
  onSelect: (metric: ResearchMetric) => void;
  depth: number;
}) {
  return (
    <div role="group" aria-label={namespace.key}>
      <div
        className="flex h-7 items-center justify-between border-b border-border/60 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
        style={{ paddingLeft: `${0.65 + depth * 0.75}rem` }}
      >
        <span>{namespace.label}</span>
        <span>{metricNamespaceCount(namespace)}</span>
      </div>
      {namespace.metrics.map((metric) => (
        <MetricRow
          key={metric.key}
          metric={metric}
          selectedMetricKey={selectedMetricKey}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
      {namespace.children.map((child) => (
        <MetricNamespace
          key={child.key}
          namespace={child}
          selectedMetricKey={selectedMetricKey}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function MetricScoreboard({
  metrics,
  selectedMetricKey,
  onSelect,
}: {
  metrics: readonly ResearchMetric[];
  selectedMetricKey: string;
  onSelect: (metric: ResearchMetric) => void;
}) {
  const tree = researchMetricTree(metrics);
  return (
    <aside className="min-w-0 border-b lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">Goal metrics</h2>
          <p className="text-[9px] text-muted-foreground">Select one to inspect its raw trajectory.</p>
        </div>
        <Badge variant="outline" className="font-mono text-[9px]">{metrics.length}</Badge>
      </div>
      <nav aria-label="Goal metrics" className="max-h-[25rem] overflow-auto">
        {tree.metrics.map((metric) => (
          <MetricRow
            key={metric.key}
            metric={metric}
            selectedMetricKey={selectedMetricKey}
            onSelect={onSelect}
            depth={0}
          />
        ))}
        {tree.namespaces.map((namespace) => (
          <MetricNamespace
            key={namespace.key}
            namespace={namespace}
            selectedMetricKey={selectedMetricKey}
            onSelect={onSelect}
            depth={0}
          />
        ))}
      </nav>
    </aside>
  );
}

export function ResearchRunPage() {
  const { project: projectParam = "", sessionName: sessionParam = "" } = useParams();
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedMetricKey, setSelectedMetricKey] = useState("");
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
  const metrics = useMemo(() => (session ? researchMetrics(session) : []), [session]);
  const selectedMetric =
    metrics.find((metric) => metric.key === selectedMetricKey) ?? metrics[0] ?? null;

  useEffect(() => {
    if (!session || !selectedMetric) return;
    if (selectedMetricKey !== selectedMetric.key) {
      setSelectedMetricKey(selectedMetric.key);
    }
    if (!selectedMetric.runs.some((location) => location.run.run_id === selectedRunId)) {
      const target =
        selectedMetric.points.at(-1)?.run ??
        selectedMetric.bestPoint?.run ??
        selectedMetric.runs.at(-1)?.run;
      if (target) setSelectedRunId(target.run_id);
    }
  }, [selectedMetric, selectedMetricKey, selectedRunId, session]);

  const location = session?.campaigns
    .map((campaign) => ({
      campaign,
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
  if (!session || !selectedCampaign || !selectedMetric) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/20" />;
  }

  const selectRun = (run: ResearchRun) => {
    setSelectedRunId(run.run_id);
    setSelectedMetricKey(researchMetricKey(run.research.objective_name, run.research.goal));
  };
  const selectMetric = (metric: ResearchMetric) => {
    setSelectedMetricKey(metric.key);
    const target = metric.points.at(-1)?.run ?? metric.bestPoint?.run ?? metric.runs.at(-1)?.run;
    if (target) setSelectedRunId(target.run_id);
  };
  const explicitLearnings = session.runs.filter((run) => run.research_outcome !== null);
  const workedLearnings = explicitLearnings.filter(
    (run) => run.research_outcome?.decision === "keep",
  );
  const failedLearnings = explicitLearnings.filter((run) =>
    ["discard", "fail", "inconclusive"].includes(run.research_outcome?.decision ?? ""),
  );
  const running = session.runs.filter((run) => run.state === "running").length;
  const selectedAttemptNumber =
    session.runs.findIndex((run) => run.run_id === selectedRunId) + 1;
  const parent = selectedRun?.research.parent_run_id
    ? session.runs.find((run) => run.run_id === selectedRun.research.parent_run_id)
    : undefined;
  const subject = selectedRun?.research.subject_run_id
    ? session.runs.find((run) => run.run_id === selectedRun.research.subject_run_id)
    : undefined;
  const hasProposalContext = Boolean(
    selectedRun?.research.rationale ||
      selectedRun?.research.expected_outcome ||
      selectedRun?.research.falsification_criteria,
  );

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
            {session.project} · {session.runs.length} attempts · {metrics.length} goal metrics ·{" "}
            {runDuration(session.startedAt, session.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {running > 0 ? <StatusDot tone="live" label={`${running} running`} /> : <StatusDot tone="idle" label="complete" />}
          <span>{explicitLearnings.length} controller outcomes</span>
        </div>
      </header>

      <Card className="overflow-hidden">
        <div className="grid lg:grid-cols-[21rem_minmax(0,1fr)]">
          <MetricScoreboard
            metrics={metrics}
            selectedMetricKey={selectedMetric.key}
            onSelect={selectMetric}
          />
          <section className="min-w-0">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
              <div className="min-w-0">
                <h2 className="truncate font-mono text-sm font-semibold">{selectedMetric.objectiveName}</h2>
                <p className="text-[9px] text-muted-foreground">
                  Raw values · {selectedMetric.goal === "minimize" ? "lower" : "higher"} is better
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 font-mono text-[9px]">
                {selectedMetric.points.length} evaluated
              </Badge>
            </div>
            <div className="px-3 pb-3 pt-1">
              {selectedMetric.points.length > 0 ? (
                <ResearchTrajectoryChart
                  metric={selectedMetric}
                  selectedRunId={selectedRunId}
                  onSelect={(run) => selectRun(run)}
                />
              ) : (
                <div className="grid h-48 place-items-center text-xs text-muted-foreground">
                  Waiting for the first objective value…
                </div>
              )}
            </div>
          </section>
        </div>
      </Card>

      <Tabs defaultValue="attempts" className="min-w-0">
        <TabsList className="h-8">
          <TabsTrigger value="attempts" className="text-xs">Attempts</TabsTrigger>
          <TabsTrigger value="hypotheses" className="text-xs">Idea lineage</TabsTrigger>
          <TabsTrigger value="learnings" className="text-xs">
            Learnings <span className="ml-1 text-[9px] opacity-60">{workedLearnings.length + failedLearnings.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attempts" className="mt-3">
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
            <SessionExperimentTree
              metric={selectedMetric}
              selectedRunId={selectedRunId}
              onSelect={(run) => selectRun(run)}
            />

            <Card className="min-w-0">
              <CardHeader className="flex-row items-center justify-between space-y-0 px-4 py-2.5">
                <div className="min-w-0">
                  <CardTitle className="text-sm">
                    {selectedRun ? `Attempt ${selectedAttemptNumber}` : "Attempt"}
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
                    {hasProposalContext ? (
                      <section className="border-t pt-3">
                        <dl className="space-y-3 text-sm">
                          {selectedRun.research.rationale ? (
                            <div>
                              <dt className="text-[10px] uppercase text-muted-foreground">Rationale</dt>
                              <dd className="mt-0.5 leading-relaxed">{selectedRun.research.rationale}</dd>
                            </div>
                          ) : null}
                          {selectedRun.research.expected_outcome ? (
                            <div>
                              <dt className="text-[10px] uppercase text-muted-foreground">Expected</dt>
                              <dd className="mt-0.5 text-xs leading-relaxed">{selectedRun.research.expected_outcome}</dd>
                            </div>
                          ) : null}
                          {selectedRun.research.falsification_criteria ? (
                            <div>
                              <dt className="text-[10px] uppercase text-muted-foreground">Falsified when</dt>
                              <dd className="mt-0.5 text-xs leading-relaxed">{selectedRun.research.falsification_criteria}</dd>
                            </div>
                          ) : null}
                        </dl>
                      </section>
                    ) : null}

                    {selectedAnalysis.source === "controller" ? (
                      <section className="border-t pt-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Outcome</h2>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="font-mono text-[9px] uppercase">
                              {researchVerdictLabel(selectedAnalysis)}
                            </Badge>
                            <span className="text-[9px] text-muted-foreground">
                              recorded by controller
                            </span>
                          </div>
                        </div>
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
                      </section>
                    ) : null}

                    <details className="border-t pt-3 text-xs">
                      <summary className="cursor-pointer select-none text-muted-foreground">Lineage and raw data</summary>
                      <div className="mt-3 space-y-4">
                        <section>
                          <h3 className="mb-1 text-[10px] uppercase text-muted-foreground">Lineage</h3>
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            <span>parent · {parent ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => selectRun(parent)}>{shortHash(parent.run_id, 10)}</button> : selectedRun.research.parent_run_id ? shortHash(selectedRun.research.parent_run_id, 10) : "root"}</span>
                            {selectedRun.research.subject_run_id ? <span>evaluates · {subject ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => selectRun(subject)}>{shortHash(subject.run_id, 10)}</button> : shortHash(selectedRun.research.subject_run_id, 10)}</span> : null}
                            <span>source · <span className="font-mono">{selectedRun.commit_sha ? shortHash(selectedRun.commit_sha, 10) : "uncommitted"}</span></span>
                          </div>
                        </section>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <section><h3 className="mb-1 text-[10px] uppercase text-muted-foreground">Config</h3><KeyValues values={detailQuery.data?.config ?? {}} /></section>
                          <section><h3 className="mb-1 text-[10px] uppercase text-muted-foreground">Metrics</h3><KeyValues values={detailQuery.data?.summary ?? {}} /></section>
                        </div>
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
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-2.5">
                <CardTitle className="text-sm">Worked</CardTitle>
                <Badge variant="outline" className="font-mono text-[9px]">{workedLearnings.length}</Badge>
              </CardHeader>
              <CardContent className="p-0">
                {workedLearnings.length > 0 ? (
                  <div className="divide-y">
                    {workedLearnings.map((run) => {
                      const outcome = run.research_outcome;
                      if (!outcome) return null;
                      return (
                        <button
                          key={run.run_id}
                          type="button"
                          onClick={() => selectRun(run)}
                          className="w-full px-4 py-3 text-left hover:bg-accent/50"
                        >
                          <span className="block text-xs font-medium leading-snug">{run.research.hypothesis}</span>
                          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{outcome.conclusion}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="p-5 text-center text-xs text-muted-foreground">
                    No idea has been explicitly kept yet.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-2.5">
                <CardTitle className="text-sm">Didn't work or prove out</CardTitle>
                <Badge variant="outline" className="font-mono text-[9px]">{failedLearnings.length}</Badge>
              </CardHeader>
              <CardContent className="p-0">
                {failedLearnings.length > 0 ? (
                  <div className="divide-y">
                    {failedLearnings.map((run) => {
                      const outcome = run.research_outcome;
                      if (!outcome) return null;
                      return (
                        <button
                          key={run.run_id}
                          type="button"
                          onClick={() => selectRun(run)}
                          className="w-full px-4 py-3 text-left hover:bg-accent/50"
                        >
                          <span className="mb-1 block font-mono text-[8px] uppercase text-muted-foreground">{outcome.decision}</span>
                          <span className="block text-xs font-medium leading-snug">{run.research.hypothesis}</span>
                          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{outcome.conclusion}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="p-5 text-center text-xs text-muted-foreground">
                    No rejected or inconclusive idea has an explicit conclusion yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Baselines are omitted. Legacy attempts without controller-authored conclusions are not promoted into learnings.
          </p>
        </TabsContent>
      </Tabs>

      <p className="text-[10px] text-muted-foreground">
        Live sessions refresh every 5 seconds; completed sessions refresh on focus. Full run data loads only for the selected attempt.
      </p>
    </div>
  );
}
