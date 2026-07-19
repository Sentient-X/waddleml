import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  FileText,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button, EmptyState, Input, PageHeader, Textarea } from "@sx/ui";

import { waddleApi, WaddleApiError } from "@/api/client";
import type { RenderBlock, RenderReport, Report } from "@/api/types";
import { BlockRenderer } from "@/components/report/BlockRenderer";

const NEW_TEMPLATE = [
  "# New report",
  "",
  "Markdown with named ```sql``` fences and component tags, rendered over your org's data.",
  "",
  "```sql runs_by_state",
  "select state, count(*) as n",
  "from runs",
  "group by state",
  "order by n desc",
  "```",
  "",
  "<DataTable query={runs_by_state} />",
  "",
].join("\n");

/** Every query id referenced by a component block, recursively — used to surface
 *  errors for interpolation-only queries that back no visible component. */
function blockQueryIds(blocks: readonly RenderBlock[], acc = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.kind === "component" && b.query) acc.add(b.query);
    if (b.children) blockQueryIds(b.children, acc);
  }
  return acc;
}

function CompileError({ error }: { error: WaddleApiError }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        {error.code ? (
          <span className="mr-2 font-mono text-xs uppercase text-destructive">{error.code}</span>
        ) : null}
        <span className="text-destructive">{error.message}</span>
      </div>
    </div>
  );
}

export function ReportPage({ isNew = false }: { isNew?: boolean }) {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [mode, setMode] = useState<"view" | "source">(isNew ? "source" : "view");
  const [draft, setDraft] = useState<string>(isNew ? NEW_TEMPLATE : "");
  const [newName, setNewName] = useState("");
  const [rendered, setRendered] = useState<RenderReport | null>(null);
  const [renderedAt, setRenderedAt] = useState<Date | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const autoRendered = useRef(false);

  const reportQuery = useQuery({
    queryKey: ["report", name],
    queryFn: () => waddleApi.getReport(name),
    enabled: !isNew,
  });
  const report: Report | undefined = reportQuery.data;

  // Load the saved body into the editor once per report identity.
  const loadedName = report?.name;
  useEffect(() => {
    if (report) setDraft(report.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedName]);

  const requiredParams = rendered?.required_params ?? report?.required_params ?? [];

  function paramRecord(keys: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = searchParams.get(k) ?? "";
    return out;
  }

  const renderMutation = useMutation<RenderReport, WaddleApiError, Record<string, string>>({
    mutationFn: (params) => waddleApi.renderReport(name, params),
    onSuccess: (data) => {
      setRendered(data);
      setRenderedAt(new Date());
    },
  });

  const previewMutation = useMutation<
    RenderReport,
    WaddleApiError,
    { body: string; params: Record<string, string> }
  >({
    mutationFn: ({ body, params }) => waddleApi.previewReport(body, params),
    onSuccess: (data) => {
      setRendered(data);
      setRenderedAt(new Date());
    },
  });

  const saveMutation = useMutation<Report, WaddleApiError, void>({
    mutationFn: () => waddleApi.saveReport(isNew ? newName.trim() : name, draft),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["report", saved.name] });
      if (isNew) {
        navigate(`/reports/${encodeURIComponent(saved.name)}`);
      } else {
        setMode("view");
        renderMutation.mutate(paramRecord(saved.required_params));
      }
    },
  });

  const deleteMutation = useMutation<null, WaddleApiError, void>({
    mutationFn: () => waddleApi.deleteReport(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      navigate("/reports");
    },
  });

  // Auto-render a param-free report once it loads.
  useEffect(() => {
    if (isNew || !report || autoRendered.current) return;
    if (report.required_params.length === 0) {
      autoRendered.current = true;
      renderMutation.mutate({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  function runRender() {
    renderMutation.mutate(paramRecord(requiredParams));
  }

  function runPreview() {
    previewMutation.mutate({ body: draft, params: paramRecord(requiredParams) });
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

  const title = rendered?.title ?? report?.title ?? (isNew ? "New report" : name);
  const description = rendered?.description ?? report?.description ?? null;
  const rendering = renderMutation.isPending || previewMutation.isPending;
  const unconsumedErrors = rendered
    ? Object.entries(rendered.query_errors).filter(
        ([q]) => !blockQueryIds(rendered.blocks).has(q),
      )
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
              {!isNew ? <span className="font-mono text-xs">{name}</span> : null}
              {renderedAt ? (
                <span className="text-xs text-muted-foreground">
                  rendered {renderedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </span>
          }
          actions={
            <div className="flex items-center gap-1.5">
              <div className="mr-1 flex items-center rounded-lg border p-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "view" ? "secondary" : "ghost"}
                  className="h-7"
                  onClick={() => setMode("view")}
                >
                  <Eye className="h-4 w-4" /> View
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "source" ? "secondary" : "ghost"}
                  className="h-7"
                  onClick={() => setMode("source")}
                >
                  <Pencil className="h-4 w-4" /> Source
                </Button>
              </div>
              {mode === "view" && !isNew ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={runRender}
                  disabled={rendering}
                >
                  <RefreshCw className="h-4 w-4" /> Re-render
                </Button>
              ) : null}
              {!isNew ? (
                confirmDelete ? (
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
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )
              ) : null}
            </div>
          }
        />
      </div>

      {deleteMutation.isError ? <CompileError error={deleteMutation.error} /> : null}

      {/* Params bar — one input per required param, persisted in the URL. */}
      {requiredParams.length > 0 && mode === "view" ? (
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

      {mode === "source" ? (
        <div className="flex flex-col gap-2">
          {isNew ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-mono text-muted-foreground">name</span>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-8 w-72"
                placeholder="my-report"
              />
            </label>
          ) : null}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={22}
            className="font-mono text-xs"
            placeholder="# Report title\n\n```sql my_query\nselect …\n```\n\n<BigValue query={my_query} value=… />"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || (isNew && !newName.trim())}
            >
              <Save className="h-4 w-4" /> {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runPreview}
              disabled={rendering}
            >
              <Eye className="h-4 w-4" /> Preview
            </Button>
            <span className="text-xs text-muted-foreground">
              Preview renders the draft without saving; Save compile-validates then stores.
            </span>
          </div>
          {saveMutation.isError ? <CompileError error={saveMutation.error} /> : null}
          {previewMutation.isError ? <CompileError error={previewMutation.error} /> : null}
        </div>
      ) : null}

      {/* Rendered output (shown in both modes; Source keeps a live preview). */}
      {renderMutation.isError && mode === "view" ? (
        <CompileError error={renderMutation.error} />
      ) : null}

      {unconsumedErrors.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {unconsumedErrors.map(([q, message]) => (
            <div
              key={q}
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <span className="mr-2 font-mono text-xs uppercase text-destructive">{q}</span>
                <span className="text-destructive">{message}</span>
              </div>
            </div>
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
      ) : mode === "view" && !isNew && requiredParams.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading report…</p>
      ) : mode === "view" && requiredParams.length > 0 ? (
        <EmptyState
          icon={<FileText />}
          title="Set parameters to render"
          hint="This report takes parameters — fill them above and press Run."
        />
      ) : null}
    </div>
  );
}
