/* Report view (`/reports/:id`) — the read/render surface. Auto-renders a
   param-free report on load; params ride the URL and drive a manual Run; actions
   are Edit (→ the editor) and Delete. No inline source mode — authoring lives in
   the editor page now. */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button, EmptyState, Input, PageHeader } from "@sx/ui";

import { waddleApi, WaddleApiError } from "@/api/client";
import type { RenderBlock, RenderReport } from "@/api/types";
import { BlockRenderer } from "@/components/report/BlockRenderer";
import { ErrorBanner } from "@/components/report/ErrorBanner";

/** Query ids referenced by a component block, recursively — used to surface
 *  errors for interpolation-only queries that back no visible component. */
function blockQueryIds(blocks: readonly RenderBlock[], acc = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.kind === "component" && b.query) acc.add(b.query);
    if (b.children) blockQueryIds(b.children, acc);
  }
  return acc;
}

export function ReportViewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rendered, setRendered] = useState<RenderReport | null>(null);
  const [renderedAt, setRenderedAt] = useState<Date | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const autoRendered = useRef(false);

  const reportQuery = useQuery({
    queryKey: ["report", id],
    queryFn: () => waddleApi.getReport(id),
  });
  const report = reportQuery.data;
  const requiredParams = rendered?.required_params ?? report?.required_params ?? [];

  function paramRecord(keys: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = searchParams.get(k) ?? "";
    return out;
  }

  const renderMutation = useMutation<RenderReport, WaddleApiError, Record<string, string>>({
    mutationFn: (params) => waddleApi.renderReport(id, params),
    onSuccess: (data) => {
      setRendered(data);
      setRenderedAt(new Date());
    },
  });

  const deleteMutation = useMutation<null, WaddleApiError, void>({
    mutationFn: () => waddleApi.deleteReport(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      navigate("/reports");
    },
  });

  // Auto-render a param-free report once it loads.
  useEffect(() => {
    if (!report || autoRendered.current) return;
    if (report.required_params.length === 0) {
      autoRendered.current = true;
      renderMutation.mutate({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  function runRender() {
    renderMutation.mutate(paramRecord(requiredParams));
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  if (reportQuery.isError) {
    return (
      <EmptyState
        icon={<FileText />}
        title="Report not found"
        hint={(reportQuery.error as Error).message}
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/reports">Back to reports</Link>
          </Button>
        }
      />
    );
  }

  const title = rendered?.title ?? report?.title ?? report?.name ?? "Report";
  const description = rendered?.description ?? report?.description ?? null;
  const rendering = renderMutation.isPending;
  const unconsumedErrors = rendered
    ? Object.entries(rendered.query_errors).filter(([q]) => !blockQueryIds(rendered.blocks).has(q))
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          to="/reports"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Reports
        </Link>
        <PageHeader
          title={title}
          description={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {description ? <span>{description}</span> : null}
              {report ? <span className="font-mono text-xs">{report.name}</span> : null}
              {report ? (
                <span className="font-mono text-xs text-muted-foreground">v{report.version}</span>
              ) : null}
              {renderedAt ? (
                <span className="text-xs text-muted-foreground">
                  rendered {renderedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </span>
          }
          actions={
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={runRender} disabled={rendering}>
                <RefreshCw className="h-4 w-4" /> Re-render
              </Button>
              <Button asChild size="sm" variant="secondary">
                <Link to={`/reports/${id}/edit`}>
                  <Pencil className="h-4 w-4" /> Edit
                </Link>
              </Button>
              {confirmDelete ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" /> Confirm
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              )}
            </div>
          }
        />
      </div>

      {deleteMutation.isError ? <ErrorBanner message={deleteMutation.error.message} /> : null}

      {/* Params bar — one input per required param, persisted in the URL. */}
      {requiredParams.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
          {requiredParams.map((key) => (
            <label key={key} className="flex flex-col gap-1 text-xs">
              <span className="font-mono text-muted-foreground">{key}</span>
              <Input
                value={searchParams.get(key) ?? ""}
                onChange={(e) => setParam(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runRender();
                }}
                className="h-8 w-44"
                placeholder={key}
              />
            </label>
          ))}
          <Button type="button" size="sm" onClick={runRender} disabled={rendering}>
            <Play className="h-4 w-4" /> {rendering ? "Running…" : "Run"}
          </Button>
        </div>
      ) : null}

      {renderMutation.isError ? (
        <ErrorBanner code={renderMutation.error.code} message={renderMutation.error.message} />
      ) : null}

      {unconsumedErrors.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {unconsumedErrors.map(([q, message]) => (
            <ErrorBanner key={q} code={q} message={message} />
          ))}
        </div>
      ) : null}

      {rendering && !rendered ? (
        <p className="text-sm text-muted-foreground">Rendering…</p>
      ) : rendered ? (
        <BlockRenderer
          blocks={rendered.blocks}
          results={rendered.results}
          queryErrors={rendered.query_errors}
        />
      ) : requiredParams.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading report…</p>
      ) : (
        <EmptyState
          icon={<FileText />}
          title="Set parameters to render"
          hint="This report takes parameters — fill them above and press Run."
        />
      )}
    </div>
  );
}
