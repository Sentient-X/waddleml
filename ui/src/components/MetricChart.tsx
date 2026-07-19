import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSeries {
  label: string;
  points: readonly { step: number; value: number }[];
  kind?: "line" | "points" | "step";
}

/* A small palette that reads on both light and dark canvases (uPlot draws to a
   canvas, so CSS variables can't reach it — these are fixed, theme-neutral). */
const PALETTE = [
  "#2563eb",
  "#f97316",
  "#16a34a",
  "#db2777",
  "#9333ea",
  "#0891b2",
  "#ca8a04",
  "#dc2626",
] as const;

const AXIS_STROKE = "#8a8f98";
const GRID_STROKE = "rgba(128,128,128,0.16)";

/** Align many (step → value) series onto one shared, sorted step axis; missing
 *  steps become null so uPlot draws gaps rather than fake straight lines. */
function align(series: readonly ChartSeries[]): AlignedData {
  const steps = new Set<number>();
  for (const s of series) for (const p of s.points) steps.add(p.step);
  const xs = [...steps].sort((a, b) => a - b);
  const index = new Map(xs.map((step, i) => [step, i]));
  const ys = series.map((s) => {
    const col: (number | null)[] = new Array(xs.length).fill(null);
    for (const p of s.points) col[index.get(p.step)!] = p.value;
    return col;
  });
  return [xs, ...ys];
}

/**
 * A thin, typed uPlot wrapper: line charts of step → value with resize
 * handling. The plot is rebuilt when the series set changes (labels/count) and
 * only re-fed data when the points change, so streaming updates stay cheap.
 */
export function MetricChart({
  series,
  height = 200,
  yLog = false,
}: {
  series: readonly ChartSeries[];
  height?: number;
  yLog?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo(() => align(series), [series]);
  // Structural signature — a change here means the plot must be rebuilt.
  const signature = useMemo(
    () =>
      `${height}|${yLog}|${series
        .map((s) => `${s.label}:${s.kind ?? "line"}`)
        .join("\u0000")}`,
    [series, height, yLog],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const options: Options = {
      width: el.clientWidth || 600,
      height,
      scales: { x: { time: false }, y: yLog ? { distr: 3, log: 10 } : {} },
      legend: { show: series.length > 1 && !series.some((item) => item.kind === "points") },
      cursor: { points: { size: 5 } },
      axes: [
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE }, ticks: { stroke: GRID_STROKE } },
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE }, ticks: { stroke: GRID_STROKE } },
      ],
      series: [
        { label: "step" },
        ...series.map((s, i) => ({
          label: s.label,
          stroke: PALETTE[i % PALETTE.length],
          width: s.kind === "points" ? 0 : 1.5,
          paths: s.kind === "step" ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
          points: { show: s.kind === "points", size: 6 },
        })),
      ],
    };
    const plot = new uPlot(options, data, el);
    plotRef.current = plot;
    const observer = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 600, height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={containerRef} className="w-full" />;
}
