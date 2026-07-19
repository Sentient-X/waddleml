/* Report editor (`/reports/new` and `/reports/:id/edit`) — a first-class
   authoring surface: CodeMirror on the left, a live server-rendered preview on
   the right. The draft auto-previews ~1s after typing stops (stale responses are
   dropped); compile errors show inline in the preview pane without freezing the
   editor. The top bar renames (rename rides the save), saves (create → land on
   the new id; update → bump the version), views, and opens version history. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Eye, History, Save } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  PageHeader,
} from "@sx/ui";

import { waddleApi, WaddleApiError } from "@/api/client";
import type { RenderReport } from "@/api/types";
import { BlockRenderer } from "@/components/report/BlockRenderer";
import { ErrorBanner } from "@/components/report/ErrorBanner";
import { ReportEditor } from "@/components/report/ReportEditor";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

const NEW_TEMPLATE = [
  "# New report",
  "",
  "Markdown with named ```sql``` fences and component tags, rendered live over your org's data.",
  "",
  "```sql runs_by_state",
  "select state, count(*) as n",
  "from runs",
  "group by state",
  "order by n desc",
  "```",
  "",
  "```sql recent_runs",
  "select name, project, state, created_at",
  "from runs",
  "order by created_at desc",
  "limit 20",
  "```",
  "",
  "```sql loss_curve",
  "select step, value",
  "from metrics",
  "where metric_name = 'loss'",
  "order by step",
  "```",
  "",
  '<Grid cols="3">',
  '  <BigValue data={runs_by_state} value="n" title="Runs (top state)" />',
  "</Grid>",
  "",
  "## Recent runs",
  "",
  "<DataTable data={recent_runs} />",
  "",
  "## Loss curve",
  "",
  '<LineChart data={loss_curve} x="step" y="value" title="loss" />',
  "",
].join("\n");

/** Compact relative time ("3m ago") for the version list. */
function relativeTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function ReportEditorPage({ isNew = false }: { isNew?: boolean }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [draft, setDraft] = useState(isNew ? NEW_TEMPLATE : "");
  const [params, setParams] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<RenderReport | null>(null);
  const [previewError, setPreviewError] = useState<WaddleApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saveError, setSaveError] = useState<WaddleApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const previewSeq = useRef(0);

  const reportQuery = useQuery({
    queryKey: ["report", id],
    queryFn: () => waddleApi.getReport(id),
    enabled: !isNew,
  });
  const report = reportQuery.data;

  const datasetsQuery = useQuery({ queryKey: ["datasets"], queryFn: () => waddleApi.listDatasets() });
  const datasets = useMemo(
    () => (datasetsQuery.data ?? []).map((d) => d.dataset),
    [datasetsQuery.data],
  );

  const versionsQuery = useQuery({
    queryKey: ["report-versions", id],
    queryFn: () => waddleApi.listReportVersions(id),
    enabled: !isNew && historyOpen,
  });

  // Load the saved body + name once per report identity.
  const loadedId = report?.id;
  useEffect(() => {
    if (report) {
      setDraft(report.body);
      setName(report.name);
      setViewingVersion(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  const runPreview = useCallback(async (body: string, p: Record<string, string>) => {
    const seq = ++previewSeq.current;
    setPreviewing(true);
    try {
      const data = await waddleApi.previewReport(body, p);
      if (seq !== previewSeq.current) return;
      setRendered(data);
      setPreviewError(null);
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPreviewError(e as WaddleApiError);
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }, []);

  // Auto-preview: debounce ~1s after the draft or params settle.
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    if (!draft.trim()) return;
    const timer = setTimeout(() => void runPreview(draft, params), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, paramsKey, runPreview]);

  const requiredParams = rendered?.required_params ?? [];

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedNote(null);
    try {
      if (isNew) {
        const created = await waddleApi.createReport(name.trim(), draft);
        queryClient.invalidateQueries({ queryKey: ["reports"] });
        navigate(`/reports/${created.id}/edit`, { replace: true });
      } else {
        const rename = name.trim() !== report?.name ? name.trim() : undefined;
        const saved = await waddleApi.updateReport(id, draft, rename);
        queryClient.invalidateQueries({ queryKey: ["reports"] });
        queryClient.invalidateQueries({ queryKey: ["report", id] });
        queryClient.invalidateQueries({ queryKey: ["report-versions", id] });
        setViewingVersion(null);
        setSavedNote(`v${saved.version} saved`);
      }
    } catch (e) {
      setSaveError(e as WaddleApiError);
    } finally {
      setSaving(false);
    }
  }

  async function loadVersion(version: number) {
    setHistoryOpen(false);
    try {
      const got = await waddleApi.getReportVersion(id, version);
      setDraft(got.body);
      setName(got.name);
      setViewingVersion(version);
      setSavedNote(null);
    } catch (e) {
      setSaveError(e as WaddleApiError);
    }
  }

  const nameValid = NAME_PATTERN.test(name.trim());
  const canSave = !saving && nameValid && draft.trim().length > 0;

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <Link
          to={isNew ? "/reports" : `/reports/${id}`}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> {isNew ? "Reports" : "Back to report"}
        </Link>
        <PageHeader
          title={isNew ? "New report" : "Edit report"}
          description="Markdown + named ```sql fences + component tags — the editor previews live over your org's data."
          actions={
            <div className="flex items-center gap-1.5">
              <div className="flex flex-col">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 w-56 font-mono text-xs"
                  placeholder="my-report (slug)"
                  aria-invalid={name.length > 0 && !nameValid}
                />
              </div>
              <Button type="button" size="sm" onClick={() => void save()} disabled={!canSave}>
                <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save"}
              </Button>
              {!isNew ? (
                <>
                  <Button asChild size="sm" variant="secondary">
                    <Link to={`/reports/${id}`}>
                      <Eye className="h-4 w-4" /> View
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistoryOpen(true)}
                  >
                    <History className="h-4 w-4" /> History
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {name.length > 0 && !nameValid ? (
            <span className="text-destructive">
              slug must be lowercase letters, digits or hyphens (a–z 0–9 -)
            </span>
          ) : null}
          {viewingVersion !== null ? (
            <span className="rounded border border-warning/40 bg-warning/5 px-2 py-0.5 font-mono text-warning">
              viewing v{viewingVersion} (unsaved) — Save to restore as a new version
            </span>
          ) : null}
          {savedNote ? (
            <span className="inline-flex items-center gap-1 text-emerald-500">
              <Check className="h-3.5 w-3.5" /> {savedNote}
            </span>
          ) : null}
          <span className="text-muted-foreground">⌘/Ctrl+S save · ⌘/Ctrl+↵ preview now</span>
        </div>
      </div>

      {saveError ? <ErrorBanner code={saveError.code} message={saveError.message} /> : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Editor */}
        <div className="min-h-0 overflow-hidden rounded-lg border">
          <div className="h-[calc(100vh-15rem)] min-h-[24rem]">
            <ReportEditor
              value={draft}
              onChange={setDraft}
              onSave={() => {
                if (canSave) void save();
              }}
              onPreview={() => void runPreview(draft, params)}
              datasets={datasets}
            />
          </div>
        </div>

        {/* Live preview */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto rounded-lg border bg-card/40 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </span>
            {previewing ? <span className="text-xs text-muted-foreground">previewing…</span> : null}
          </div>

          {requiredParams.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              {requiredParams.map((key) => (
                <label key={key} className="flex flex-col gap-1 text-xs">
                  <span className="font-mono text-muted-foreground">{key}</span>
                  <Input
                    value={params[key] ?? ""}
                    onChange={(e) => setParams((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="h-8 w-40"
                    placeholder={key}
                  />
                </label>
              ))}
            </div>
          ) : null}

          {previewError ? (
            <ErrorBanner code={previewError.code} message={previewError.message} />
          ) : null}

          {rendered ? (
            <BlockRenderer
              blocks={rendered.blocks}
              results={rendered.results}
              queryErrors={rendered.query_errors}
            />
          ) : previewing ? (
            <p className="text-sm text-muted-foreground">Rendering…</p>
          ) : (
            <EmptyState icon={<Eye />} title="Start typing" hint="The preview renders as you write." />
          )}
        </div>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
          </DialogHeader>
          {versionsQuery.isError ? (
            <ErrorBanner message={(versionsQuery.error as Error).message} />
          ) : (
            <div className="flex max-h-[60vh] flex-col divide-y overflow-auto">
              {(versionsQuery.data ?? []).map((v) => (
                <button
                  key={v.version}
                  type="button"
                  onClick={() => void loadVersion(v.version)}
                  className="flex items-center justify-between gap-3 px-1 py-2 text-left text-sm hover:bg-muted/40"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono">v{v.version}</span>
                    <span className="font-mono text-xs text-muted-foreground">{v.name}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{v.updated_by ?? "—"}</span>
                    <span>{relativeTime(v.created_at)}</span>
                  </span>
                </button>
              ))}
              {versionsQuery.isLoading ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">Loading history…</p>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
