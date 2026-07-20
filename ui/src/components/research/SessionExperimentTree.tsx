import { Badge, Card, CardContent, CardHeader, CardTitle, StatusDot, cn } from "@sx/ui";

import { formatScalar, runStateTone } from "@/lib/format";
import {
  researchVerdictLabel,
  type ResearchCampaign,
  type ResearchMetric,
  type ResearchRun,
} from "@/lib/research";

function verdictTone(verdict: string): string {
  if (verdict === "keep") return "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400";
  if (verdict === "baseline") return "border-blue-600/40 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  if (verdict === "fail") return "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400";
  if (verdict === "inconclusive") return "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

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
        <CardTitle className="flex items-center justify-between gap-3 text-sm">
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
              <button
                key={run.run_id}
                type="button"
                onClick={() => onSelect(run, campaign)}
                className={cn(
                  "grid w-full grid-cols-[2.4rem_minmax(0,1fr)_5.5rem] gap-2 border-l-2 border-transparent px-2 py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "border-l-blue-500 bg-accent/70",
                )}
              >
                <span className="flex items-start gap-1 pt-0.5 font-mono text-[9px] text-muted-foreground">
                  <StatusDot tone={runStateTone(run.state)} />
                  {sessionOrdinal + 1}
                </span>
                <span className="min-w-0">
                  <span className="mb-1 flex flex-wrap items-center gap-1">
                    <Badge
                      variant="outline"
                      className={cn("px-1 py-0 font-mono text-[8px] uppercase", verdictTone(analysis.verdict))}
                    >
                      {researchVerdictLabel(analysis)}
                    </Badge>
                    {isBest ? <Badge className="px-1 py-0 text-[8px]">current best</Badge> : null}
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
                    <span
                      className={cn(
                        "mt-1 block text-muted-foreground",
                        point.baselineChange > 0 && "text-green-600 dark:text-green-400",
                      )}
                    >
                      {point.baselineChange > 0 ? "+" : ""}
                      {point.baselineChange.toFixed(1)}{metric.zeroBaseline ? " pp" : "%"}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
