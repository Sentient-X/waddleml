import type { ResearchTrial, Run } from "@/api/types";

export type ResearchRun = Run & { group_name: string; research: ResearchTrial };

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
}

export interface ResearchTrajectoryPhase {
  campaign: ResearchCampaign;
  phaseIndex: number;
  zeroBaseline: boolean;
  points: ResearchTrajectoryPoint[];
}

export function isResearchRun(run: Run): run is ResearchRun {
  return run.group_name !== null && run.research !== null;
}

export function researchSessionName(run: ResearchRun): string {
  const explicit = run.research.session_name?.trim();
  return explicit || run.project;
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
  if (run.state !== "completed") return null;
  const value = run.summary[run.research.objective_name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function researchSessionsFrom(runs: readonly Run[]): ResearchSession[] {
  const sessionMembers = new Map<string, ResearchRun[]>();
  for (const run of runs) {
    if (!isResearchRun(run)) continue;
    const sessionName = researchSessionName(run);
    const key = researchSessionKey(run.project, sessionName);
    const bucket = sessionMembers.get(key) ?? [];
    bucket.push(run);
    sessionMembers.set(key, bucket);
  }

  return [...sessionMembers.entries()]
    .map(([key, members]) => {
      const campaignMembers = new Map<string, ResearchRun[]>();
      for (const run of members) {
        const sessionName = researchSessionName(run);
        const key = campaignKey(
          run.project,
          sessionName,
          run.group_name,
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
            project: first.project,
            sessionName: researchSessionName(first),
            name: first.group_name,
            objectiveName: first.research.objective_name,
            goal: first.research.goal,
            runs: ordered,
          } satisfies ResearchCampaign;
        })
        .sort((a, b) => latestTimestamp(a.runs[0]) - latestTimestamp(b.runs[0]));
      const startedAt = new Date(
        Math.min(...members.map((run) => new Date(run.started_at).getTime())),
      ).toISOString();
      const updatedAt = new Date(Math.max(...members.map(latestTimestamp))).toISOString();
      const first = members[0];
      return {
        key,
        project: first.project,
        name: researchSessionName(first),
        campaigns,
        runs: [...members].sort((a, b) => latestTimestamp(a) - latestTimestamp(b)),
        startedAt,
        updatedAt,
      } satisfies ResearchSession;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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

export function researchTrajectory(session: ResearchSession): ResearchTrajectoryPhase[] {
  let ordinal = 0;
  return session.campaigns.flatMap((campaign, phaseIndex) => {
    const evaluated = campaign.runs.flatMap((run) => {
      const value = objectiveValue(run);
      return value === null ? [] : [{ run, value }];
    });
    const baseline = evaluated[0]?.value;
    if (baseline === undefined) return [];
    let incumbent = baseline;
    const points = evaluated.map(({ run, value }) => {
      if (better(campaign.goal, value, incumbent)) incumbent = value;
      const point = {
        ordinal,
        phaseIndex,
        run,
        rawValue: value,
        improvement: directionalImprovement(campaign, baseline, value),
        incumbentImprovement: directionalImprovement(campaign, baseline, incumbent),
      } satisfies ResearchTrajectoryPoint;
      ordinal += 1;
      return point;
    });
    return [
      {
        campaign,
        phaseIndex,
        zeroBaseline: Math.abs(baseline) <= 1e-12,
        points,
      } satisfies ResearchTrajectoryPhase,
    ];
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
  let selected: ResearchRun | null = null;
  let selectedValue: number | null = null;
  for (const run of campaign.runs) {
    const value = objectiveValue(run);
    if (value !== null && (selectedValue === null || better(campaign.goal, value, selectedValue))) {
      selected = run;
      selectedValue = value;
    }
  }
  return selected;
}

export function researchSessionPath(session: Pick<ResearchSession, "project" | "name">): string {
  return `/research/${encodeURIComponent(session.project)}/${encodeURIComponent(session.name)}`;
}
