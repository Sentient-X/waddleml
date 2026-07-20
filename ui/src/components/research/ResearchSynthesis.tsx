import { Badge, Card, CardContent, CardHeader, CardTitle } from "@sx/ui";

import {
  researchAnalyses,
  type ResearchAnalysis,
  type ResearchCampaign,
  type ResearchRun,
  type ResearchSession,
} from "@/lib/research";

interface SynthesisRow {
  run: ResearchRun;
  campaign: ResearchCampaign;
  phaseIndex: number;
  analysis: ResearchAnalysis;
}

function SynthesisItem({
  row,
  onSelect,
}: {
  row: SynthesisRow;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.run, row.campaign)}
      className="w-full rounded-md border p-3 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase text-muted-foreground">
          P{row.phaseIndex + 1} · trial {row.run.research.trial_index}
        </span>
        <Badge
          variant={row.analysis.verdict === "failed" ? "destructive" : "outline"}
          className={
            row.analysis.verdict === "kept"
              ? "border-green-600/40 bg-green-500/10 px-1.5 py-0 text-[9px] text-green-700 dark:text-green-400"
              : "px-1.5 py-0 text-[9px]"
          }
        >
          {row.analysis.verdict}
        </Badge>
      </div>
      <div className="mt-1.5 text-xs font-medium leading-relaxed">
        {row.run.research.hypothesis}
      </div>
      <div className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
        {row.analysis.evidence}
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-foreground/80">
        {row.analysis.conclusion}
      </div>
    </button>
  );
}

export function ResearchSynthesis({
  session,
  onSelect,
}: {
  session: ResearchSession;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const rows = session.campaigns.flatMap((campaign, phaseIndex) => {
    const analyses = researchAnalyses(campaign);
    return campaign.runs.flatMap((run) => {
      const analysis = analyses.get(run.run_id);
      return analysis ? [{ run, campaign, phaseIndex, analysis }] : [];
    });
  });
  const working = rows.filter((row) => row.analysis.verdict === "kept").slice(-8).reverse();
  const lessons = rows
    .filter(
      (row) => row.analysis.verdict === "discarded" || row.analysis.verdict === "failed",
    )
    .slice(-8)
    .reverse();

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Research synthesis</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          The newest accepted mechanisms and negative results, derived from objective deltas,
          recorded gates, and evaluator conclusions.
        </p>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
              Ideas that are working
            </h2>
            <span className="font-mono text-[10px] text-muted-foreground">latest 8</span>
          </div>
          <div className="grid gap-2">
            {working.length > 0 ? (
              working.map((row) => (
                <SynthesisItem key={row.run.run_id} row={row} onSelect={onSelect} />
              ))
            ) : (
              <p className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                No accepted improvement has been recorded yet.
              </p>
            )}
          </div>
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Conclusions from discarded ideas
            </h2>
            <span className="font-mono text-[10px] text-muted-foreground">latest 8</span>
          </div>
          <div className="grid gap-2">
            {lessons.length > 0 ? (
              lessons.map((row) => (
                <SynthesisItem key={row.run.run_id} row={row} onSelect={onSelect} />
              ))
            ) : (
              <p className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                No discarded or failed idea has been recorded yet.
              </p>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
