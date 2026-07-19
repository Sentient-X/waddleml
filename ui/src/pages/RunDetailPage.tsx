import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  FileDown,
  Search,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@sx/ui";

import { MetricChart } from "@/components/MetricChart";
import { waddleApi } from "@/api/client";
import type { ArtifactVersion, LogLine, MetricSeries, RunLineage } from "@/api/types";
import { formatDateTime, formatScalar, runDuration, runStateTone, shortHash } from "@/lib/format";

/* ── config tree (the W&B metadata-tree pattern: nested keys, collapsible
      subtrees, search across full key paths) ──────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function flattenEntries(value: unknown, prefix: string, out: [string, unknown][]): void {
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      flattenEntries(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out.push([prefix, value]);
  }
}

function TreeNode({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (!isRecord(value)) {
    return (
      <div
        className="flex items-baseline justify-between gap-4 border-b py-1 last:border-0"
        style={{ paddingLeft: depth * 16 + 20 }}
      >
        <span className="text-sm text-muted-foreground">{name}</span>
        <span className="font-mono text-xs tabular-nums break-all text-right">
          {formatScalar(value)}
        </span>
      </div>
    );
  }
  const entries = Object.entries(value);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 border-b py-1 text-left text-sm hover:bg-accent/40"
        style={{ paddingLeft: depth * 16 }}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{entries.length}</span>
      </button>
      {open
        ? entries.map(([k, v]) => <TreeNode key={k} name={k} value={v} depth={depth + 1} />)
        : null}
    </div>
  );
}

function KeyTree({ title, data }: { title: string; data: Record<string, unknown> }) {
  const [query, setQuery] = useState("");
  const flat = useMemo(() => {
    const out: [string, unknown][] = [];
    flattenEntries(data, "", out);
    return out;
  }, [data]);
  const needle = query.trim().toLowerCase();
  const matches = needle ? flat.filter(([path]) => path.toLowerCase().includes(needle)) : null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keys…"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="rounded-lg border px-3 py-1">
        {flat.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing recorded.</p>
        ) : matches ? (
          matches.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No keys match “{query}”.</p>
          ) : (
            matches.map(([path, value]) => (
              <div
                key={path}
                className="flex items-baseline justify-between gap-4 border-b py-1 last:border-0"
              >
                <span className="font-mono text-xs text-muted-foreground">{path}</span>
                <span className="font-mono text-xs tabular-nums break-all text-right">
                  {formatScalar(value)}
                </span>
              </div>
            ))
          )
        ) : (
          Object.entries(data).map(([k, v]) => (
            <TreeNode key={k} name={k} value={v} depth={0} />
          ))
        )}
      </div>
    </section>
  );
}

/* ── charts, auto-grouped into collapsible sections by metric prefix ────── */

function metricGroups(series: readonly MetricSeries[]): { name: string; charts: MetricSeries[] }[] {
  const groups = new Map<string, MetricSeries[]>();
  for (const s of series) {
    const slash = s.metric_name.indexOf("/");
    const key = slash > 0 ? s.metric_name.slice(0, slash) : "metrics";
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([name, charts]) => ({ name, charts }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ChartSection({ name, charts }: { name: string; charts: MetricSeries[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {name}
        <Badge variant="secondary" className="text-[10px]">
          {charts.length}
        </Badge>
      </button>
      {open ? (
        <div className="grid gap-4 border-t p-3 md:grid-cols-2 xl:grid-cols-3">
          {charts.map((series) => (
            <div key={series.metric_name} className="rounded-lg border p-3">
              <div className="mb-1 font-mono text-xs text-muted-foreground">
                {series.metric_name}
              </div>
              <MetricChart
                series={[
                  {
                    label: series.metric_name,
                    points: series.points.map((p) => ({ step: p.step, value: p.value })),
                  },
                ]}
                height={170}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── logs: searchable, level-filterable tail ────────────────────────────── */

const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;

const LEVEL_CLASS: Record<string, string> = {
  warning: "text-warning",
  error: "text-destructive",
};

function LogsPane({ lines, live }: { lines: LogLine[]; live: boolean }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const visible = lines.filter(
    (l) =>
      (level === null || l.level === level) &&
      (needle === "" || l.message.toLowerCase().includes(needle)),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search log messages…"
            className="h-8 w-72 pl-7 text-xs"
          />
        </div>
        <div className="inline-flex rounded-md border border-input p-0.5">
          {[null, ...LOG_LEVELS].map((lv) => (
            <button
              key={lv ?? "all"}
              type="button"
              onClick={() => setLevel(lv)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                level === lv
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {lv ?? "all"}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {visible.length} of {lines.length} lines
        </span>
        {live ? <StatusDot tone="live" label="streaming" /> : null}
      </div>
      <div className="h-[32rem] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <span className="text-muted-foreground">
            {lines.length === 0 ? "No log lines." : "No lines match the filter."}
          </span>
        ) : (
          visible.map((line, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="shrink-0 text-muted-foreground">{formatDateTime(line.ts)}</span>
              <span
                className={cn(
                  "shrink-0 uppercase",
                  LEVEL_CLASS[line.level] ?? "text-muted-foreground",
                )}
              >
                {line.level}
              </span>
              <span>{line.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── lineage: inputs → run → outputs, artifacts expandable to signed files ── */

function ArtifactNode({ row }: { row: RunLineage }) {
  const [open, setOpen] = useState(false);
  const artifactQuery = useQuery({
    queryKey: ["artifact", row.artifact_id],
    queryFn: () => waddleApi.getArtifact(row.artifact_id),
    enabled: open,
  });
  const artifact: ArtifactVersion | undefined = artifactQuery.data;
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        <span className="flex items-center gap-2">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{row.collection}</span>
          <span className="text-muted-foreground">v{row.version}</span>
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {shortHash(row.artifact_id)}
        </span>
      </button>
      {open ? (
        <div className="border-t px-3 py-2">
          {artifactQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Resolving signed URLs…</p>
          ) : artifactQuery.isError ? (
            <p className="text-xs text-destructive">{(artifactQuery.error as Error).message}</p>
          ) : artifact ? (
            <ul className="flex flex-col gap-1">
              {artifact.files.map((file) => (
                <li key={file.sha256} className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono break-all">{file.logical_path}</span>
                  <a
                    href={file.download_url}
                    className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline"
                  >
                    <FileDown className="h-3 w-3" /> download
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LineageGraph({ rows, runName }: { rows: RunLineage[]; runName: string }) {
  const inputs = rows.filter((r) => r.relation === "input");
  const outputs = rows.filter((r) => r.relation === "output");
  const side = (items: RunLineage[], empty: string) =>
    items.length === 0 ? (
      <p className="rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    ) : (
      <div className="flex flex-col gap-2">
        {items.map((row) => (
          <ArtifactNode key={row.artifact_id} row={row} />
        ))}
      </div>
    );

  return (
    <div className="grid items-center gap-3 lg:grid-cols-[1fr_auto_auto_auto_1fr]">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Consumed
        </span>
        {side(inputs, "No input artifacts")}
      </div>
      <ArrowRight className="hidden h-4 w-4 justify-self-center text-muted-foreground lg:block" />
      <div className="justify-self-center rounded-lg border-2 border-primary/50 bg-primary/5 px-4 py-3 text-center">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Run</div>
        <div className="max-w-56 truncate text-sm font-medium">{runName}</div>
      </div>
      <ArrowRight className="hidden h-4 w-4 justify-self-center text-muted-foreground lg:block" />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Produced
        </span>
        {side(outputs, "No output artifacts")}
      </div>
    </div>
  );
}

/* ── the page ───────────────────────────────────────────────────────────── */

export function RunDetailPage() {
  const { runId = "" } = useParams();

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => waddleApi.getRun(runId),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 5000 : false),
  });
  const running = runQuery.data?.state === "running";

  const metricsQuery = useQuery({
    queryKey: ["run-metrics", runId],
    queryFn: () => waddleApi.queryMetrics({ run_ids: [runId], metric_names: [], max_points: 2000 }),
    refetchInterval: running ? 5000 : false,
  });

  const logsQuery = useQuery({
    queryKey: ["run-logs", runId],
    queryFn: () => waddleApi.runLogs(runId, 1000),
    refetchInterval: running ? 5000 : false,
  });

  const lineageQuery = useQuery({
    queryKey: ["run-lineage", runId],
    queryFn: () => waddleApi.runLineage(runId),
  });

  const run = runQuery.data;
  const groups = useMemo(() => metricGroups(metricsQuery.data ?? []), [metricsQuery.data]);
  const logCount = (logsQuery.data ?? []).length;
  const lineageCount = (lineageQuery.data ?? []).length;

  if (runQuery.isError) {
    return (
      <EmptyState
        icon={<Boxes />}
        title="Run not found"
        hint={(runQuery.error as Error).message}
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/">Back to runs</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          to="/"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Runs
        </Link>
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {run ? run.display_name ?? run.name : runId.slice(0, 12)}
              {run ? <StatusDot tone={runStateTone(run.state)} label={run.state} /> : null}
            </span>
          }
          description={
            run ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs">
                <span>{run.project}</span>
                <span>· {runDuration(run.started_at, run.finished_at)}</span>
                <span>· {run.run_id.slice(0, 16)}</span>
                {run.commit_sha ? <span>· {shortHash(run.commit_sha, 10)}</span> : null}
              </span>
            ) : (
              "Loading run…"
            )
          }
        />
      </div>

      <Tabs defaultValue="charts">
        <TabsList>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="logs">Logs {logCount > 0 ? `(${logCount})` : ""}</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="lineage">
            Lineage {lineageCount > 0 ? `(${lineageCount})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="charts" className="mt-4 flex flex-col gap-3">
          {metricsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading metrics…</p>
          ) : groups.length === 0 ? (
            <EmptyState
              icon={<Boxes />}
              title="No metrics logged"
              hint="Scalar series appear here once the run reports metric points."
            />
          ) : (
            groups.map((g) => <ChartSection key={g.name} name={g.name} charts={g.charts} />)
          )}
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          {logsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading logs…</p>
          ) : (
            <LogsPane lines={logsQuery.data ?? []} live={running} />
          )}
        </TabsContent>

        <TabsContent value="config" className="mt-4 flex flex-col gap-5">
          <KeyTree title="Config" data={run?.config ?? {}} />
          <KeyTree title="Summary" data={run?.summary ?? {}} />
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Workers</h2>
            {run && run.workers.length > 0 ? (
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-1.5 text-left">Rank</th>
                      <th className="px-3 py-1.5 text-left">Node</th>
                      <th className="px-3 py-1.5 text-right">World</th>
                      <th className="px-3 py-1.5 text-right">Attempt</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs tabular-nums">
                    {run.workers.map((w) => (
                      <tr key={`${w.rank}-${w.attempt}`} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{w.rank}</td>
                        <td className="px-3 py-1.5 break-all">{w.node_id}</td>
                        <td className="px-3 py-1.5 text-right">{w.world_size}</td>
                        <td className="px-3 py-1.5 text-right">{w.attempt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-1 py-2 text-sm text-muted-foreground">No workers attached.</p>
            )}
          </section>
        </TabsContent>

        <TabsContent value="lineage" className="mt-4">
          {lineageQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading lineage…</p>
          ) : lineageCount === 0 ? (
            <EmptyState
              icon={<Boxes />}
              title="No artifacts linked"
              hint="Artifacts this run consumes or produces appear here with their lineage."
            />
          ) : (
            <LineageGraph
              rows={lineageQuery.data ?? []}
              runName={run ? run.display_name ?? run.name : runId}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
