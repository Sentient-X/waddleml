import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from "@sx/ui";

import { formatScalar } from "@/lib/format";
import {
  objectiveValue,
  researchRunLocations,
  researchVerdictLabel,
  type LocatedResearchRun,
  type ResearchCampaign,
  type ResearchRun,
  type ResearchSession,
} from "@/lib/research";

function verdictTone(verdict: string): string {
  if (verdict === "keep") return "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400";
  if (verdict === "baseline") return "border-blue-600/40 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  if (verdict === "fail") return "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400";
  if (verdict === "inconclusive") return "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

function IdeaButton({
  location,
  selectedRunId,
  onSelect,
}: {
  location: LocatedResearchRun;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const value = objectiveValue(location.run);
  return (
    <button
      type="button"
      onClick={() => onSelect(location.run, location.campaign)}
      className={cn(
        "w-full rounded-md border border-l-4 bg-background px-3 py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        location.run.run_id === selectedRunId && "border-blue-500 bg-accent/60",
        location.analysis.verdict === "keep" && "border-l-green-600",
        location.analysis.verdict === "fail" && "border-l-red-600",
        location.analysis.verdict === "inconclusive" && "border-l-amber-600",
        location.analysis.verdict === "discard" && "border-l-slate-500",
        location.analysis.verdict === "baseline" && "border-l-blue-600",
        location.analysis.verdict === "running" && "border-l-violet-600",
      )}
    >
      <span className="flex items-center justify-between gap-2 font-mono text-[8px] uppercase text-muted-foreground">
        <span>attempt {location.sessionOrdinal + 1} · {researchVerdictLabel(location.analysis)}</span>
        <span>{value === null ? "—" : formatScalar(value)}</span>
      </span>
      <span className="mt-1 line-clamp-2 text-[11px] font-medium leading-snug">
        {location.run.research.hypothesis}
      </span>
    </button>
  );
}

function parentChain(
  selected: LocatedResearchRun,
  byId: ReadonlyMap<string, LocatedResearchRun>,
): LocatedResearchRun[] {
  const chain: LocatedResearchRun[] = [];
  const visited = new Set([selected.run.run_id]);
  let cursor = selected;
  while (cursor.run.research.parent_run_id) {
    const parent = byId.get(cursor.run.research.parent_run_id);
    if (!parent || visited.has(parent.run.run_id)) break;
    visited.add(parent.run.run_id);
    chain.unshift(parent);
    cursor = parent;
  }
  return chain;
}

export function HypothesisTreeMap({
  session,
  selectedRunId,
  onSelect,
}: {
  session: ResearchSession;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const locations = researchRunLocations(session);
  const byId = new Map(locations.map((location) => [location.run.run_id, location]));
  const selected = byId.get(selectedRunId) ?? locations.at(-1);
  if (!selected) return null;

  const ancestors = parentChain(selected, byId);
  const visibleAncestors = ancestors.slice(-5);
  const children = locations.filter(
    (location) => location.run.research.parent_run_id === selected.run.run_id,
  );
  const evaluations = locations.filter(
    (location) => location.run.research.subject_run_id === selected.run.run_id,
  );
  const evaluatedSubject = selected.run.research.subject_run_id
    ? byId.get(selected.run.research.subject_run_id)
    : undefined;
  const roots = locations.filter((location) => {
    const parentId = location.run.research.parent_run_id;
    return !parentId || !byId.has(parentId) || parentId === location.run.run_id;
  });
  const kept = locations.filter((location) => location.analysis.verdict === "keep").length;
  const rejected = locations.filter((location) =>
    ["discard", "fail"].includes(location.analysis.verdict),
  ).length;
  const unresolved = locations.filter((location) =>
    ["running", "inconclusive"].includes(location.analysis.verdict),
  ).length;
  const controllerBacked = locations.filter(
    (location) => location.analysis.source === "controller",
  ).length;
  const value = objectiveValue(selected.run);

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 px-4 py-3">
        <div>
          <CardTitle className="text-sm">Idea lineage</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            The path into the selected idea, its result, and the ideas or evaluations it produced.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">{kept} metric winners</span>
          <span>{rejected} non-winners / failed</span>
          <span className="text-amber-600 dark:text-amber-400">{unresolved} unresolved</span>
          <span>{controllerBacked} concluded</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-0">
        <div className="grid gap-3 border-t pt-3 lg:grid-cols-[minmax(13rem,0.7fr)_minmax(20rem,1.3fr)_minmax(14rem,0.85fr)]">
          <section className="min-w-0">
            <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              What led here
            </h3>
            {visibleAncestors.length > 0 ? (
              <div className="space-y-2">
                {ancestors.length > visibleAncestors.length ? (
                  <p className="text-center text-[9px] text-muted-foreground">
                    {ancestors.length - visibleAncestors.length} earlier ancestors…
                  </p>
                ) : null}
                {visibleAncestors.map((ancestor) => (
                  <IdeaButton
                    key={ancestor.run.run_id}
                    location={ancestor}
                    selectedRunId={selectedRunId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                This is a root direction.
              </p>
            )}
            {evaluatedSubject ? (
              <div className="mt-3">
                <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  This run evaluates
                </h3>
                <IdeaButton
                  location={evaluatedSubject}
                  selectedRunId={selectedRunId}
                  onSelect={onSelect}
                />
              </div>
            ) : null}
          </section>

          <section className="min-w-0 rounded-lg border-2 border-blue-500/60 bg-blue-500/[0.035] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("font-mono text-[9px] uppercase", verdictTone(selected.analysis.verdict))}
                >
                  {researchVerdictLabel(selected.analysis)}
                </Badge>
                <span className="font-mono text-[9px] text-muted-foreground">
                  attempt {selected.sessionOrdinal + 1}
                </span>
              </div>
              <span className="font-mono text-[9px] text-muted-foreground">
                {selected.run.research.objective_name} · {value === null ? "—" : formatScalar(value)}
              </span>
            </div>
            <h2 className="text-base font-semibold leading-snug">
              {selected.run.research.hypothesis}
            </h2>
            {selected.run.research.rationale ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {selected.run.research.rationale}
              </p>
            ) : null}
            <div className="mt-4 border-t pt-3">
              <h3 className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                What we learned
              </h3>
              {selected.analysis.source === "controller" ? (
                <>
                  <p className="mt-1 text-sm leading-relaxed">{selected.analysis.conclusion}</p>
                  {selected.analysis.evidence ? (
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {selected.analysis.evidence}
                    </p>
                  ) : null}
                  {selected.analysis.failedGates.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selected.analysis.failedGates.map((gate) => (
                        <Badge key={gate} variant="destructive" className="font-mono text-[8px]">
                          {gate}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="mt-1 text-xs italic leading-relaxed text-muted-foreground">
                  This legacy attempt has no controller-authored conclusion. Waddle only knows its
                  numeric selection state.
                </p>
              )}
            </div>
            {selected.analysis.nextStep ? (
              <div className="mt-3 border-t pt-3">
                <h3 className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Next step
                </h3>
                <p className="mt-1 text-xs leading-relaxed">{selected.analysis.nextStep}</p>
              </div>
            ) : null}
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              What followed
            </h3>
            {children.length + evaluations.length > 0 ? (
              <div className="space-y-2">
                {children.map((child) => (
                  <IdeaButton
                    key={child.run.run_id}
                    location={child}
                    selectedRunId={selectedRunId}
                    onSelect={onSelect}
                  />
                ))}
                {evaluations.map((evaluation) => (
                  <div key={evaluation.run.run_id}>
                    <p className="mb-1 pl-1 text-[8px] font-semibold uppercase text-blue-600 dark:text-blue-400">
                      evaluation
                    </p>
                    <IdeaButton
                      location={evaluation}
                      selectedRunId={selectedRunId}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No recorded child idea or evaluation.
              </p>
            )}
          </section>
        </div>

        <details className="border-t pt-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            Browse {roots.length} root directions
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {roots.map((root) => (
              <IdeaButton
                key={root.run.run_id}
                location={root}
                selectedRunId={selectedRunId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
