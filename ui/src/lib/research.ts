import type {
  ResearchDecision,
  ResearchSessionSummary,
  ResearchSessionTrial,
  ResearchTrial,
} from "@/api/types";

export type ResearchRun = ResearchSessionTrial;

export interface ResearchCampaign {
  key: string;
  project: string;
  sessionName: string;
  name: string;
  objectiveName: string;
  goal: ResearchTrial["goal"];
  runs: ResearchRun[];
}

export interface ResearchSession {
  key: string;
  project: string;
  name: string;
  campaigns: ResearchCampaign[];
  runs: ResearchRun[];
  startedAt: string;
  updatedAt: string;
}

export interface LocatedResearchRun {
  sessionOrdinal: number;
  phaseIndex: number;
  run: ResearchRun;
  campaign: ResearchCampaign;
  analysis: ResearchAnalysis;
}

export interface ResearchMetricPoint extends LocatedResearchRun {
  metricOrdinal: number;
  rawValue: number;
  incumbentValue: number;
  baselineChange: number;
  movedIncumbent: boolean;
}

export interface ResearchMetric {
  key: string;
  objectiveName: string;
  goal: ResearchTrial["goal"];
  runs: LocatedResearchRun[];
  points: ResearchMetricPoint[];
  bestPoint: ResearchMetricPoint | null;
  zeroBaseline: boolean;
}

export interface ResearchMetricNamespace {
  key: string;
  label: string;
  metrics: ResearchMetric[];
  children: ResearchMetricNamespace[];
}

export interface ResearchMetricTree {
  metrics: ResearchMetric[];
  namespaces: ResearchMetricNamespace[];
}

export type ResearchVerdict =
  | ResearchDecision
  | "running";

export interface ResearchAnalysis {
  verdict: ResearchVerdict;
  source: "controller" | "legacy-derived";
  evidence: string | null;
  conclusion: string | null;
  failedGates: string[];
  nextStep: string | null;
  baselineImprovement: number | null;
}

export function researchVerdictLabel(analysis: ResearchAnalysis): string {
  if (analysis.source === "controller") return analysis.verdict;
  if (analysis.verdict === "keep") return "metric best";
  if (analysis.verdict === "discard") return "non-best";
  if (analysis.verdict === "fail") return "failed";
  if (analysis.verdict === "inconclusive") return "unresolved";
  return analysis.verdict;
}

export function researchSessionKey(project: string, name: string): string {
  return JSON.stringify([project, name]);
}

function campaignKey(
  project: string,
  sessionName: string,
  campaign: string,
  objectiveName: string,
  goal: ResearchTrial["goal"],
): string {
  return JSON.stringify([project, sessionName, campaign, objectiveName, goal]);
}

export function researchMetricKey(
  objectiveName: string,
  goal: ResearchTrial["goal"],
): string {
  return JSON.stringify([objectiveName, goal]);
}

export function objectiveValue(run: ResearchRun): number | null {
  return run.state === "completed" ? run.objective_value : null;
}

export function orderedRuns(runs: readonly ResearchRun[]): ResearchRun[] {
  return [...runs].sort(
    (a, b) =>
      a.research.trial_index - b.research.trial_index ||
      new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );
}

function latestTimestamp(run: ResearchRun): number {
  return new Date(run.heartbeat_at ?? run.finished_at ?? run.started_at).getTime();
}

export function researchSessionFrom(
  project: string,
  sessionName: string,
  runs: readonly ResearchRun[],
): ResearchSession | null {
  if (runs.length === 0) return null;
  const campaignMembers = new Map<string, ResearchRun[]>();
  for (const run of runs) {
    const key = campaignKey(
      project,
      sessionName,
      run.campaign,
      run.research.objective_name,
      run.research.goal,
    );
    const bucket = campaignMembers.get(key) ?? [];
    bucket.push(run);
    campaignMembers.set(key, bucket);
  }
  const campaigns = [...campaignMembers.entries()]
    .map(([key, campaignRuns]) => {
      const ordered = orderedRuns(campaignRuns);
      const first = ordered[0];
      return {
        key,
        project,
        sessionName,
        name: first.campaign,
        objectiveName: first.research.objective_name,
        goal: first.research.goal,
        runs: ordered,
      } satisfies ResearchCampaign;
    })
    .sort(
      (a, b) =>
        new Date(a.runs[0].started_at).getTime() -
        new Date(b.runs[0].started_at).getTime(),
    );
  return {
    key: researchSessionKey(project, sessionName),
    project,
    name: sessionName,
    campaigns,
    runs: [...runs].sort(
      (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
    ),
    startedAt: new Date(
      Math.min(...runs.map((run) => new Date(run.started_at).getTime())),
    ).toISOString(),
    updatedAt: new Date(Math.max(...runs.map(latestTimestamp))).toISOString(),
  };
}

function directionalImprovement(
  goal: ResearchTrial["goal"],
  baseline: number,
  value: number,
): number {
  const delta = goal === "minimize" ? baseline - value : value - baseline;
  return Math.abs(baseline) > 1e-12 ? (delta / Math.abs(baseline)) * 100 : delta * 100;
}

function derivedVerdict(
  run: ResearchRun,
  value: number | null,
  isBaseline: boolean,
  improvesIncumbent: boolean,
): ResearchVerdict {
  if (run.state === "running") return "running";
  if (run.state === "failed" || run.state === "aborted") return "fail";
  if (value === null) return "inconclusive";
  if (isBaseline) return "baseline";
  return improvesIncumbent ? "keep" : "discard";
}

function accepted(verdict: ResearchVerdict): boolean {
  return verdict === "baseline" || verdict === "keep";
}

export function researchAnalyses(campaign: ResearchCampaign): Map<string, ResearchAnalysis> {
  const analyses = new Map<string, ResearchAnalysis>();
  const evaluated = campaign.runs.flatMap((run) => {
    const value = objectiveValue(run);
    return value === null ? [] : [{ run, value }];
  });
  const baseline = evaluated[0]?.value;
  let incumbent = baseline;

  for (const run of campaign.runs) {
    const value = objectiveValue(run);
    const isBaseline = run.run_id === evaluated[0]?.run.run_id;
    const improvesIncumbent =
      value !== null && incumbent !== undefined && better(campaign.goal, value, incumbent);
    const outcome = run.research_outcome;
    const verdict = outcome?.decision ?? derivedVerdict(run, value, isBaseline, improvesIncumbent);
    const baselineImprovement =
      value !== null && baseline !== undefined
        ? directionalImprovement(campaign.goal, baseline, value)
        : null;
    analyses.set(run.run_id, {
      verdict,
      source: outcome ? "controller" : "legacy-derived",
      evidence: outcome?.evidence ?? null,
      conclusion: outcome?.conclusion ?? null,
      failedGates: outcome?.failed_gates ?? [],
      nextStep: outcome?.next_step ?? null,
      baselineImprovement,
    });
    if (accepted(verdict) && value !== null && incumbent !== undefined) {
      if (better(campaign.goal, value, incumbent)) incumbent = value;
    }
  }
  return analyses;
}

export function researchRunLocations(session: ResearchSession): LocatedResearchRun[] {
  const campaignLocation = new Map(
    session.campaigns.flatMap((campaign, phaseIndex) => {
      const analyses = researchAnalyses(campaign);
      return campaign.runs.map(
        (run) => [
          run.run_id,
          {
            campaign,
            phaseIndex,
            analysis: analyses.get(run.run_id)!,
          },
        ] as const,
      );
    }),
  );
  return session.runs.flatMap((run, sessionOrdinal) => {
    const location = campaignLocation.get(run.run_id);
    return location ? [{ run, sessionOrdinal, ...location }] : [];
  });
}

export function researchMetrics(session: ResearchSession): ResearchMetric[] {
  const locations = researchRunLocations(session);
  const groups = new Map<string, LocatedResearchRun[]>();
  for (const location of locations) {
    const key = researchMetricKey(
      location.run.research.objective_name,
      location.run.research.goal,
    );
    const bucket = groups.get(key) ?? [];
    bucket.push(location);
    groups.set(key, bucket);
  }

  return [...groups.entries()]
    .map(([key, runs]) => {
      const objectiveName = runs[0].run.research.objective_name;
      const goal = runs[0].run.research.goal;
      const evaluated = runs.flatMap((location) => {
        const value = objectiveValue(location.run);
        return value === null ? [] : [{ location, value }];
      });
      const baseline = evaluated[0]?.value;
      let incumbent: number | undefined;
      let bestPoint: ResearchMetricPoint | null = null;
      const points = evaluated.flatMap(({ location, value }, metricOrdinal) => {
        if (baseline === undefined) return [];
        const qualifies = accepted(location.analysis.verdict);
        const movedIncumbent =
          qualifies && (incumbent === undefined || better(goal, value, incumbent));
        if (movedIncumbent) incumbent = value;
        if (incumbent === undefined) return [];
        const point = {
          ...location,
          metricOrdinal,
          rawValue: value,
          incumbentValue: incumbent,
          baselineChange: directionalImprovement(goal, baseline, value),
          movedIncumbent,
        } satisfies ResearchMetricPoint;
        if (movedIncumbent) bestPoint = point;
        return [point];
      });
      return {
        key,
        objectiveName,
        goal,
        runs,
        points,
        bestPoint,
        zeroBaseline: baseline !== undefined && Math.abs(baseline) <= 1e-12,
      } satisfies ResearchMetric;
    })
    .sort(
      (left, right) =>
        right.runs.length - left.runs.length ||
        left.runs[0].sessionOrdinal - right.runs[0].sessionOrdinal,
    );
}

interface MutableMetricNamespace {
  key: string;
  label: string;
  metrics: ResearchMetric[];
  children: Map<string, MutableMetricNamespace>;
}

function freezeMetricNamespace(node: MutableMetricNamespace): ResearchMetricNamespace {
  return {
    key: node.key,
    label: node.label,
    metrics: node.metrics,
    children: [...node.children.values()].map(freezeMetricNamespace),
  };
}

export function researchMetricTree(metrics: readonly ResearchMetric[]): ResearchMetricTree {
  const rootMetrics: ResearchMetric[] = [];
  const roots = new Map<string, MutableMetricNamespace>();
  for (const metric of metrics) {
    const segments = metric.objectiveName.split("/").filter(Boolean);
    if (segments.length < 2) {
      rootMetrics.push(metric);
      continue;
    }
    let siblings = roots;
    let path = "";
    let node: MutableMetricNamespace | undefined;
    for (const segment of segments.slice(0, -1)) {
      path = path ? `${path}/${segment}` : segment;
      node = siblings.get(segment);
      if (!node) {
        node = { key: path, label: segment, metrics: [], children: new Map() };
        siblings.set(segment, node);
      }
      siblings = node.children;
    }
    node?.metrics.push(metric);
  }
  return {
    metrics: rootMetrics,
    namespaces: [...roots.values()].map(freezeMetricNamespace),
  };
}

export function researchMetricLeaf(metric: ResearchMetric): string {
  return metric.objectiveName.split("/").filter(Boolean).at(-1) ?? metric.objectiveName;
}

export function better(
  goal: ResearchTrial["goal"],
  candidate: number,
  incumbent: number,
): boolean {
  return goal === "minimize" ? candidate < incumbent : candidate > incumbent;
}

export function researchSessionPath(
  session: Pick<ResearchSessionSummary, "project" | "session_name">,
): string {
  return `/research/${encodeURIComponent(session.project)}/${encodeURIComponent(session.session_name)}`;
}
