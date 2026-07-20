import { Badge, Card, CardContent, CardHeader, CardTitle, StatusDot, cn } from "@sx/ui";

import { formatScalar, runStateTone, shortHash } from "@/lib/format";
import {
  bestRun,
  objectiveValue,
  researchTreeRows,
  type ResearchCampaign,
  type ResearchRun,
  type ResearchSession,
} from "@/lib/research";

export function SessionExperimentTree({
  session,
  selectedRunId,
  onSelect,
}: {
  session: ResearchSession;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const runLocations = new Map(
    session.campaigns.flatMap((campaign, phaseIndex) =>
      campaign.runs.map((run) => [run.run_id, { run, campaign, phaseIndex }] as const),
    ),
  );

  return (
    <Card className="min-w-0">
      <CardHeader className="py-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span>Full experiment tree</span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {session.campaigns.length} phases · {session.runs.length} trials
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[52rem] overflow-auto p-2 pt-0">
        <div className="relative pl-4">
          <span className="absolute bottom-4 left-[7px] top-4 border-l border-border" />
          {session.campaigns.map((campaign, phaseIndex) => {
            const phaseBest = bestRun(campaign);
            return (
              <section key={campaign.key} className="relative pb-3 last:pb-0">
                <span className="absolute -left-[13px] top-3 h-2 w-2 rounded-full border border-primary bg-background" />
                <button
                  type="button"
                  onClick={() => onSelect(campaign.runs[0], campaign)}
                  className="mb-1 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    P{phaseIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold" title={campaign.name}>
                      {campaign.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {campaign.objectiveName} · {campaign.goal}
                    </span>
                  </span>
                </button>
                <div className="ml-2 border-l border-dashed border-border pl-2">
                  {researchTreeRows(campaign.runs).map(({ run, depth, orphan }) => {
                    const value = objectiveValue(run);
                    const selected = run.run_id === selectedRunId;
                    const parent = run.research.parent_run_id
                      ? runLocations.get(run.research.parent_run_id)
                      : undefined;
                    const subject = run.research.subject_run_id
                      ? runLocations.get(run.research.subject_run_id)
                      : undefined;
                    return (
                      <button
                        key={run.run_id}
                        type="button"
                        onClick={() => onSelect(run, campaign)}
                        className={cn(
                          "relative flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected && "bg-accent",
                        )}
                        style={{ paddingLeft: `${8 + depth * 16}px` }}
                      >
                        {depth > 0 ? (
                          <span
                            className="absolute bottom-0 top-0 border-l border-border"
                            style={{ left: `${7 + (depth - 1) * 16}px` }}
                          />
                        ) : null}
                        <StatusDot tone={runStateTone(run.state)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1 text-[11px] font-medium">
                            trial {run.research.trial_index}
                            {run.run_id === phaseBest?.run_id ? (
                              <Badge className="px-1 py-0 text-[9px]">best</Badge>
                            ) : null}
                            {orphan && !parent ? <Badge variant="outline">orphan</Badge> : null}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {run.research.hypothesis}
                          </span>
                          {run.research.subject_run_id ? (
                            <span className="mt-0.5 block truncate font-mono text-[9px] text-primary">
                              ↗ evaluates {subject ? `P${subject.phaseIndex + 1}/trial ${subject.run.research.trial_index}` : shortHash(run.research.subject_run_id, 10)}
                            </span>
                          ) : null}
                          {parent && parent.campaign.key !== campaign.key ? (
                            <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                              ↳ from P{parent.phaseIndex + 1}/trial{" "}
                              {parent.run.research.trial_index}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums">
                          {value === null ? "—" : formatScalar(value)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
