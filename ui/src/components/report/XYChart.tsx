import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";

/* A generic XY uPlot chart for report component blocks (LineChart / BarChart /
   AreaChart). It shares MetricChart's palette + axis styling but is decoupled
   from the step→value metric shape: it takes named series over an arbitrary
   numeric x, and adds bar/area modes, a log y-scale, a y-max clamp, and
   vertical reference lines. Downsampling to a point budget stays naive (stride)
   — reports show shaped queries, not raw firehoses. */

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
const REF_STROKE = "#94a3b8";

const MAX_POINTS = 2000;

export type ChartKind = "line" | "bar" | "area";

export interface XySeries {
  label: string;
  points: readonly { x: number; y: number }[];
}

export interface ReferenceLine {
  x: number;
  label?: string;
}

/** Align many (x → y) series onto one shared, sorted x axis; missing x's become
 *  null so uPlot draws gaps rather than fake segments. */
function align(series: readonly XySeries[]): AlignedData {
  const xsSet = new Set<number>();
  for (const s of series) for (const p of s.points) xsSet.add(p.x);
  let xs = [...xsSet].sort((a, b) => a - b);
  // Naive downsample by stride to keep the canvas cheap.
  if (xs.length > MAX_POINTS) {
    const stride = Math.ceil(xs.length / MAX_POINTS);
    xs = xs.filter((_, i) => i % stride === 0);
  }
  const index = new Map(xs.map((x, i) => [x, i]));
  const ys = series.map((s) => {
    const col: (number | null)[] = new Array(xs.length).fill(null);
    for (const p of s.points) {
      const i = index.get(p.x);
      if (i !== undefined) col[i] = p.y;
    }
    return col;
  });
  return [xs, ...ys];
}

export function XYChart({
  series,
  kind = "line",
  height = 220,
  yLog = false,
  yMax,
  references = [],
  timeX = false,
}: {
  series: readonly XySeries[];
  kind?: ChartKind;
  height?: number;
  yLog?: boolean;
  yMax?: number;
  references?: readonly ReferenceLine[];
  /** x values are epoch seconds; axis renders calendar labels. */
  timeX?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo(() => align(series), [series]);
  const signature = useMemo(
    () =>
      `${kind}|${height}|${yLog}|${yMax ?? ""}|${timeX}|` +
      `${references.map((r) => r.x).join(",")}|` +
      series.map((s) => s.label).join(" "),
    [series, kind, height, yLog, yMax, references, timeX],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const bars = kind === "bar" ? uPlot.paths.bars?.({ size: [0.7, 60] }) : undefined;

    const options: Options = {
      width: el.clientWidth || 600,
      height,
      scales: {
        x: { time: timeX },
        y: { distr: yLog ? 3 : 1, range: yMax !== undefined ? [0, yMax] : undefined },
      },
      legend: { show: series.length > 1 },
      cursor: { points: { size: 5 } },
      axes: [
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE }, ticks: { stroke: GRID_STROKE } },
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE }, ticks: { stroke: GRID_STROKE } },
      ],
      series: [
        { label: "x" },
        ...series.map((s, i) => {
          const color = PALETTE[i % PALETTE.length];
          return {
            label: s.label,
            stroke: color,
            width: 1.5,
            fill: kind === "area" ? `${color}22` : undefined,
            paths: bars,
            points: { show: false },
          };
        }),
      ],
      hooks:
        references.length > 0
          ? {
              draw: [
                (u: uPlot) => {
                  const { ctx } = u;
                  ctx.save();
                  ctx.strokeStyle = REF_STROKE;
                  ctx.setLineDash([4, 3]);
                  ctx.lineWidth = 1;
                  for (const ref of references) {
                    const cx = u.valToPos(ref.x, "x", true);
                    ctx.beginPath();
                    ctx.moveTo(cx, u.bbox.top);
                    ctx.lineTo(cx, u.bbox.top + u.bbox.height);
                    ctx.stroke();
                  }
                  ctx.restore();
                },
              ],
            }
          : undefined,
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
