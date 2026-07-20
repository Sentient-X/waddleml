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

export interface ResearchTreeRow {
  run: ResearchRun;
  depth: number;
  orphan: boolean;
}

export interface ResearchTrajectoryPoint {
  ordinal: number;
  phaseIndex: number;
  run: ResearchRun;
  rawValue: number;
  improvement: number;
  incumbentImprovement: number;
  analysis: ResearchAnalysis;
}

export interface ResearchTrajectoryPhase {
  campaign: ResearchCampaign;
  phaseIndex: number;
  zeroBaseline: boolean;
  points: ResearchTrajectoryPoint[];
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

export function researchTreeRows(runs: readonly ResearchRun[]): ResearchTreeRow[] {
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

  const rows: ResearchTreeRow[] = [];
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

function directionalImprovement(
  campaign: ResearchCampaign,
  baseline: number,
  value: number,
): number {
  const delta = campaign.goal === "minimize" ? baseline - value : value - baseline;
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
        ? directionalImprovement(campaign, baseline, value)
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

export function researchTrajectory(session: ResearchSession): ResearchTrajectoryPhase[] {
  let ordinal = 0;
  return session.campaigns.flatMap((campaign, phaseIndex) => {
    const evaluated = campaign.runs.flatMap((run) => {
      const value = objectiveValue(run);
      return value === null ? [] : [{ run, value }];
    });
    const baseline = evaluated[0]?.value;
    if (baseline === undefined) return [];
    const analyses = researchAnalyses(campaign);
    let incumbent = baseline;
    const points = evaluated.flatMap(({ run, value }) => {
      const analysis = analyses.get(run.run_id);
      if (!analysis) return [];
      if (accepted(analysis.verdict) && better(campaign.goal, value, incumbent)) {
        incumbent = value;
      }
      const point = {
        ordinal,
        phaseIndex,
        run,
        rawValue: value,
        improvement: directionalImprovement(campaign, baseline, value),
        incumbentImprovement: directionalImprovement(campaign, baseline, incumbent),
        analysis,
      } satisfies ResearchTrajectoryPoint;
      ordinal += 1;
      return [point];
    });
    return [{ campaign, phaseIndex, zeroBaseline: Math.abs(baseline) <= 1e-12, points }];
  });
}

export function better(
  goal: ResearchTrial["goal"],
  candidate: number,
  incumbent: number,
): boolean {
  return goal === "minimize" ? candidate < incumbent : candidate > incumbent;
}

export function bestRun(campaign: ResearchCampaign): ResearchRun | null {
  const analyses = researchAnalyses(campaign);
  let selected: ResearchRun | null = null;
  let selectedValue: number | null = null;
  for (const run of campaign.runs) {
    const value = objectiveValue(run);
    const verdict = analyses.get(run.run_id)?.verdict;
    if (
      (verdict === "baseline" || verdict === "keep") &&
      value !== null &&
      (selectedValue === null || better(campaign.goal, value, selectedValue))
    ) {
      selected = run;
      selectedValue = value;
    }
  }
  return selected;
}

export function researchSessionPath(
  session: Pick<ResearchSessionSummary, "project" | "session_name">,
): string {
  return `/research/${encodeURIComponent(session.project)}/${encodeURIComponent(session.session_name)}`;
}
