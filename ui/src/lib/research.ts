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
  analysis: ResearchAnalysis;
}

export interface ResearchTrajectoryPhase {
  campaign: ResearchCampaign;
  phaseIndex: number;
  zeroBaseline: boolean;
  points: ResearchTrajectoryPoint[];
}

export type ResearchVerdict = "baseline" | "kept" | "discarded" | "running" | "failed";

export interface ResearchAnalysis {
  verdict: ResearchVerdict;
  conclusion: string;
  evidence: string;
  failedGates: string[];
  baselineImprovement: number | null;
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

function scalarFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

function recordedConclusion(run: ResearchRun): string | null {
  for (const key of ["rejection_reason", "verdict", "promotion_blocker"]) {
    const value = run.config[key];
    if (
      typeof value === "string" &&
      value.trim() &&
      !(key === "verdict" && value.trim().toLowerCase() === "valid")
    ) {
      return value.trim();
    }
  }
  return null;
}

function failedResearchGates(run: ResearchRun): string[] {
  return Object.entries(run.summary).flatMap(([key, value]) => {
    const correctnessGate = key.startsWith("correctness/") && /(pass|passed)$/.test(key);
    const decisionGate = key === "determinism/pass" || key === "retention/pass";
    return (correctnessGate || decisionGate) && scalarFlag(value) === false ? [key] : [];
  });
}

function percentText(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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
    const failedGates = failedResearchGates(run);
    const recorded = recordedConclusion(run);
    if (run.state === "running") {
      analyses.set(run.run_id, {
        verdict: "running",
        conclusion: "Evaluation is still running; no selection decision is implied.",
        evidence: "Waiting for a completed objective and terminal gates.",
        failedGates,
        baselineImprovement: null,
      });
      continue;
    }
    if (run.state === "failed" || run.state === "aborted") {
      analyses.set(run.run_id, {
        verdict: "failed",
        conclusion: recorded ?? `Run ${run.state}; the attempted idea remains visible.`,
        evidence: "No failed execution can become the accepted incumbent.",
        failedGates,
        baselineImprovement: null,
      });
      continue;
    }
    if (value === null || baseline === undefined || incumbent === undefined) {
      analyses.set(run.run_id, {
        verdict: "discarded",
        conclusion: recorded ?? "Completed without a finite value for the declared objective.",
        evidence: `Missing ${campaign.objectiveName}; it cannot enter the incumbent line.`,
        failedGates,
        baselineImprovement: null,
      });
      continue;
    }

    const baselineImprovement = directionalImprovement(campaign, baseline, value);
    const isBaseline = run.run_id === evaluated[0]?.run.run_id;
    const explicitlyKept =
      scalarFlag(run.config.retained) === true || scalarFlag(run.summary["retention/pass"]) === true;
    const explicitlyDiscarded =
      scalarFlag(run.config.retained) === false ||
      scalarFlag(run.summary["retention/pass"]) === false ||
      (typeof run.config.rejection_reason === "string" && run.config.rejection_reason.trim() !== "") ||
      failedGates.length > 0;
    const improvesIncumbent = better(campaign.goal, value, incumbent);
    const accepted = isBaseline || explicitlyKept || (!explicitlyDiscarded && improvesIncumbent);
    const verdict: ResearchVerdict = isBaseline ? "baseline" : accepted ? "kept" : "discarded";
    if (accepted && better(campaign.goal, value, incumbent)) incumbent = value;

    let evidence: string;
    if (isBaseline) {
      evidence = `${campaign.objectiveName} = ${value}; this is the phase comparison baseline.`;
    } else if (failedGates.length > 0) {
      evidence = `${percentText(baselineImprovement)} versus baseline, but failed ${failedGates.join(", ")}.`;
    } else if (accepted) {
      evidence = `${percentText(baselineImprovement)} versus baseline with no recorded decision gate failing.`;
    } else {
      evidence = `${percentText(baselineImprovement)} versus baseline; it did not replace the accepted incumbent.`;
    }
    const conclusion =
      recorded ??
      (verdict === "baseline"
        ? "Reference point for this campaign phase."
        : verdict === "kept"
          ? "Working: accepted onto the phase incumbent staircase."
          : "Discarded: retained as evidence, not as the running best.");
    analyses.set(run.run_id, {
      verdict,
      conclusion,
      evidence,
      failedGates,
      baselineImprovement,
    });
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
    const points = evaluated.map(({ run, value }) => {
      const analysis = analyses.get(run.run_id);
      if (!analysis) return null;
      if (
        (analysis.verdict === "baseline" || analysis.verdict === "kept") &&
        better(campaign.goal, value, incumbent)
      ) {
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
      return point;
    }).filter((point): point is ResearchTrajectoryPoint => point !== null);
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
  const analyses = researchAnalyses(campaign);
  let selected: ResearchRun | null = null;
  let selectedValue: number | null = null;
  for (const run of campaign.runs) {
    const value = objectiveValue(run);
    const verdict = analyses.get(run.run_id)?.verdict;
    const accepted = verdict === "baseline" || verdict === "kept";
    if (
      accepted &&
      value !== null &&
      (selectedValue === null || better(campaign.goal, value, selectedValue))
    ) {
      selected = run;
      selectedValue = value;
    }
  }
  return selected;
}

export function researchSessionPath(session: Pick<ResearchSession, "project" | "name">): string {
  return `/research/${encodeURIComponent(session.project)}/${encodeURIComponent(session.name)}`;
}
