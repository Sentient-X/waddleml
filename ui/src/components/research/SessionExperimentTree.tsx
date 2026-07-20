import { Badge, Card, CardContent, CardHeader, CardTitle, StatusDot } from "@sx/ui";

import { formatScalar, runStateTone } from "@/lib/format";
import {
  researchVerdictLabel,
  type ResearchCampaign,
  type ResearchMetric,
  type ResearchRun,
} from "@/lib/research";
import { ResearchListRow } from "./ResearchListRow";

export function SessionExperimentTree({
  metric,
  selectedRunId,
  onSelect,
}: {
  metric: ResearchMetric;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const pointByRun = new Map(metric.points.map((point) => [point.run.run_id, point]));

  return (
    <Card className="min-w-0">
      <CardHeader className="px-3 py-2.5">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span>Attempt ledger</span>
          <span className="font-mono text-[9px] font-normal text-muted-foreground">
            {metric.runs.length} on this goal
          </span>
        </CardTitle>
        <p className="truncate font-mono text-[9px] text-muted-foreground">
          {metric.objectiveName} · {metric.goal}
        </p>
      </CardHeader>
      <CardContent className="max-h-[52rem] overflow-auto p-1.5 pt-0">
        <div className="divide-y divide-border/70">
          {metric.runs.map((location) => {
            const { run, campaign, analysis, sessionOrdinal } = location;
            const point = pointByRun.get(run.run_id);
            const selected = run.run_id === selectedRunId;
            const isBest = run.run_id === metric.bestPoint?.run.run_id;
            return (
              <ResearchListRow
                key={run.run_id}
                onClick={() => onSelect(run, campaign)}
                selected={selected}
                className="grid grid-cols-[2.4rem_minmax(0,1fr)_5.5rem] gap-2"
              >
                <span className="flex items-start gap-1 pt-0.5 font-mono text-[9px] text-muted-foreground">
                  <StatusDot tone={runStateTone(run.state)} />
                  {sessionOrdinal + 1}
                </span>
                <span className="min-w-0">
                  <span className="mb-1 flex flex-wrap items-center gap-1">
                    <Badge
                      variant="outline"
                      className="px-1 py-0 font-mono text-[8px] uppercase"
                    >
                      {researchVerdictLabel(analysis)}
                    </Badge>
                    {isBest ? <Badge variant="outline" className="px-1 py-0 text-[8px]">current best</Badge> : null}
                    {analysis.source === "controller" ? (
                      <span className="text-[8px] text-muted-foreground">with conclusion</span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-[11px] font-medium leading-snug">
                    {run.research.hypothesis}
                  </span>
                  {analysis.source === "controller" && analysis.conclusion ? (
                    <span className="mt-1 line-clamp-1 text-[9px] text-muted-foreground">
                      {analysis.conclusion}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 text-right font-mono text-[9px] tabular-nums">
                  <span className="block text-foreground">
                    {point ? formatScalar(point.rawValue) : "—"}
                  </span>
                  {point ? (
                    <span className="mt-1 block text-muted-foreground">
                      {point.baselineChange > 0 ? "+" : ""}
                      {point.baselineChange.toFixed(1)}{metric.zeroBaseline ? " pp" : "%"}
                    </span>
                  ) : null}
                </span>
              </ResearchListRow>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
