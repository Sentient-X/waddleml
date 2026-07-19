import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCompare } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusDot,
} from "@sx/ui";

import { MetricChart, type ChartSeries } from "@/components/MetricChart";
import { waddleApi } from "@/api/client";
import { formatScalar, runStateTone } from "@/lib/format";

const MAX_RUNS = 8;

export function ComparePage() {
  const [selected, setSelected] = useState<string[]>([]);
  const [metric, setMetric] = useState<string>("");

  const runsQuery = useQuery({ queryKey: ["runs", "compare"], queryFn: () => waddleApi.listRuns({ limit: 500 }) });
  const runs = runsQuery.data ?? [];
  const byId = useMemo(() => new Map(runs.map((r) => [r.run_id, r])), [runs]);

  const latestQuery = useQuery({
    queryKey: ["compare-latest", selected],
    queryFn: () => waddleApi.queryLatest({ run_ids: selected, metric_names: [], max_points: 1 }),
    enabled: selected.length > 0,
  });
  const metricNames = useMemo(() => {
    const names = new Set((latestQuery.data ?? []).map((m) => m.metric_name));
    return [...names].sort();
  }, [latestQuery.data]);

  const metricsQuery = useQuery({
    queryKey: ["compare-metrics", selected, metric],
    queryFn: () =>
      waddleApi.queryMetrics({ run_ids: selected, metric_names: [metric], max_points: 2000 }),
    enabled: selected.length > 0 && metric !== "",
  });

  const chartSeries: ChartSeries[] = useMemo(
    () =>
      (metricsQuery.data ?? []).map((s) => ({
        label: byId.get(s.run_id)?.display_name ?? byId.get(s.run_id)?.name ?? s.run_id.slice(0, 8),
        points: s.points.map((p) => ({ step: p.step, value: p.value })),
      })),
    [metricsQuery.data, byId],
  );

  // Config diff: keys whose value differs across the selected runs.
  const diff = useMemo(() => {
    const configs = selected.map((id) => byId.get(id)?.config ?? {});
    const keys = new Set<string>();
    for (const c of configs) for (const k of Object.keys(c)) keys.add(k);
    const rows: { key: string; values: string[] }[] = [];
    for (const key of [...keys].sort()) {
      const values = configs.map((c) => formatScalar(c[key]));
      if (new Set(values).size > 1) rows.push({ key, values });
    }
    return rows;
  }, [selected, byId]);

  function toggle(runId: string) {
    setSelected((cur) =>
      cur.includes(runId)
        ? cur.filter((id) => id !== runId)
        : cur.length >= MAX_RUNS
          ? cur
          : [...cur, runId],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Compare"
        description={`Overlay metric series across up to ${MAX_RUNS} runs and diff their configs.`}
      />

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        {/* Run picker */}
        <div className="flex max-h-[70vh] flex-col overflow-hidden rounded-lg border">
          <div className="border-b px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
            Runs ({selected.length}/{MAX_RUNS})
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {runsQuery.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading runs…</p>
            ) : runs.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No runs to compare.</p>
            ) : (
              runs.map((r) => (
                <label
                  key={r.run_id}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-0 hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={selected.includes(r.run_id)}
                    onChange={() => toggle(r.run_id)}
                  />
                  <StatusDot tone={runStateTone(r.state)} />
                  <span className="min-w-0 flex-1 truncate">{r.display_name ?? r.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {r.project}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        {/* Chart + diff */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 py-3">
              <CardTitle className="text-sm">Metric overlay</CardTitle>
              <Select value={metric} onValueChange={setMetric} disabled={metricNames.length === 0}>
                <SelectTrigger className="h-8 w-56 text-xs">
                  <SelectValue placeholder="Select a metric…" />
                </SelectTrigger>
                <SelectContent>
                  {metricNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {selected.length === 0 ? (
                <EmptyState
                  icon={<GitCompare />}
                  title="Pick runs to compare"
                  hint="Select one or more runs on the left, then choose a metric."
                />
              ) : metric === "" ? (
                <EmptyState
                  icon={<GitCompare />}
                  title="Choose a metric"
                  hint="Pick a metric shared by the selected runs to overlay their series."
                />
              ) : metricsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading series…</p>
              ) : chartSeries.length === 0 ? (
                <EmptyState icon={<GitCompare />} title="No points for this metric" />
              ) : (
                <MetricChart series={chartSeries} height={280} />
              )}
            </CardContent>
          </Card>

          {selected.length >= 2 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Config diff (differing keys only)</h2>
              {diff.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  Selected runs share identical config.
                </p>
              ) : (
                <div className="overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-1.5 text-left">Key</th>
                        {selected.map((id) => (
                          <th key={id} className="px-3 py-1.5 text-left font-mono normal-case">
                            {byId.get(id)?.display_name ?? byId.get(id)?.name ?? id.slice(0, 8)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs tabular-nums">
                      {diff.map((row) => (
                        <tr key={row.key} className="border-b last:border-0">
                          <td className="px-3 py-1.5 text-muted-foreground">{row.key}</td>
                          {row.values.map((v, i) => (
                            <td key={i} className="px-3 py-1.5 break-all">
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
