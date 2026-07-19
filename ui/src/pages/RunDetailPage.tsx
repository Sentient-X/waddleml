import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Boxes, FileDown, ScrollText } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  StatusDot,
} from "@sx/ui";

import { MetricChart } from "@/components/MetricChart";
import { waddleApi } from "@/api/client";
import type { ArtifactVersion, RunLineage } from "@/api/types";
import { formatDateTime, formatScalar, runDuration, runStateTone, shortHash } from "@/lib/format";

function KeyValueTable({ entries }: { entries: readonly [string, unknown][] }) {
  if (entries.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted-foreground">Nothing recorded.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b last:border-0">
              <td className="w-1/2 whitespace-nowrap px-3 py-1.5 text-muted-foreground">{key}</td>
              <td className="px-3 py-1.5 font-mono text-xs tabular-nums break-all">
                {formatScalar(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineageArtifact({ row }: { row: RunLineage }) {
  const [open, setOpen] = useState(false);
  const artifactQuery = useQuery({
    queryKey: ["artifact", row.artifact_id],
    queryFn: () => waddleApi.getArtifact(row.artifact_id),
    enabled: open,
  });
  const artifact: ArtifactVersion | undefined = artifactQuery.data;
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        <span className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] uppercase">
            {row.relation}
          </Badge>
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
    queryFn: () => waddleApi.runLogs(runId, 400),
    refetchInterval: running ? 5000 : false,
  });

  const lineageQuery = useQuery({
    queryKey: ["run-lineage", runId],
    queryFn: () => waddleApi.runLineage(runId),
  });

  const run = runQuery.data;
  const charts = useMemo(() => metricsQuery.data ?? [], [metricsQuery.data]);

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

      {/* Metrics */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {metricsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading metrics…</p>
          ) : charts.length === 0 ? (
            <EmptyState
              icon={<Boxes />}
              title="No metrics logged"
              hint="Scalar series appear here once the run reports metric points."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
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
                    height={180}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Config + summary */}
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Config</h2>
            <KeyValueTable entries={run ? Object.entries(run.config) : []} />
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Summary</h2>
            <KeyValueTable entries={run ? Object.entries(run.summary) : []} />
          </section>
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
        </div>

        {/* Logs + lineage */}
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ScrollText className="h-4 w-4" /> Logs
              {running ? <StatusDot tone="live" /> : null}
            </h2>
            <div className="h-72 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
              {logsQuery.isLoading ? (
                <span className="text-muted-foreground">Loading logs…</span>
              ) : (logsQuery.data ?? []).length === 0 ? (
                <span className="text-muted-foreground">No log lines.</span>
              ) : (
                (logsQuery.data ?? []).map((line, i) => (
                  <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
                    <span className="shrink-0 text-muted-foreground">{formatDateTime(line.ts)}</span>
                    <span className="shrink-0 uppercase text-muted-foreground">{line.level}</span>
                    <span>{line.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Lineage</h2>
            {lineageQuery.isLoading ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Loading lineage…</p>
            ) : (lineageQuery.data ?? []).length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                No artifacts linked to this run.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {(lineageQuery.data ?? []).map((row) => (
                  <LineageArtifact key={row.artifact_id} row={row} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
