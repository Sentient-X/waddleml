/* ECharts option builders for every report chart kind — the one place the report
   dialect's chart props (x / y / series / yLog / stacked / …) become an ECharts
   option. Kept apart from the registry (registry.tsx dispatches, this file
   computes) and from the thin runtime wrapper (EChart.tsx). No echarts *runtime*
   import lives here — only the erased type — so this file stays in the main
   bundle while echarts itself is dynamically split by EChart.tsx. */

import type { EChartsOption } from "echarts";

import type { SqlResult } from "@/api/types";

export type ReportChartKind =
  | "line"
  | "bar"
  | "area"
  | "scatter"
  | "bubble"
  | "histogram"
  | "heatmap"
  | "funnel"
  | "sankey";

/** One vertical annotation drawn as a markLine; value carries the x cell raw. */
export interface ChartReference {
  value: unknown;
  label?: string;
}

/* The report palette — byte-identical to the old XYChart PALETTE so existing
   reports keep their colors. */
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

/* ── Dark-aware theme, resolved once from the live CSS vars ─────────────────
   The console themes with HSL custom properties (`--muted-foreground` etc.);
   echarts wants concrete color strings, so probe the computed rgb once and
   cache. Falls back to the muted grays the old uPlot chart hard-coded. */

interface ChartTheme {
  axis: string;
  grid: string;
  label: string;
  ref: string;
  tooltipBg: string;
  tooltipBorder: string;
}

let cachedTheme: ChartTheme | null = null;

function resolveCssColor(expr: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = expr;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return rgb || fallback;
}

/** Resolve (and memoize) the axis/label/tooltip colors from the theme. Read
 *  lazily on first chart render so the vars are mounted. */
export function chartTheme(): ChartTheme {
  if (cachedTheme) return cachedTheme;
  cachedTheme = {
    axis: resolveCssColor("hsl(var(--muted-foreground))", "#8a8f98"),
    grid: "rgba(128,128,128,0.16)",
    label: resolveCssColor("hsl(var(--muted-foreground))", "#8a8f98"),
    ref: resolveCssColor("hsl(var(--border))", "#94a3b8"),
    tooltipBg: resolveCssColor("hsl(var(--popover))", "#1e293b"),
    tooltipBorder: resolveCssColor("hsl(var(--border))", "#334155"),
  };
  return cachedTheme;
}

/* ── Small column helpers ──────────────────────────────────────────────── */

function columnIndex(result: SqlResult, name: string): number {
  return result.columns.indexOf(name);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function yColumns(props: Record<string, string>): string[] {
  return (props.y ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** True when a named column is typed `date`. */
function isDateColumn(result: SqlResult, name: string): boolean {
  const i = columnIndex(result, name);
  return i >= 0 && result.column_types[i] === "date";
}

/* ── Cartesian axis + theming scaffold shared by line/bar/area ──────────── */

function baseGrid(): EChartsOption["grid"] {
  return { left: 48, right: 16, top: 24, bottom: 32, containLabel: true };
}

function axisCommon(theme: ChartTheme) {
  return {
    axisLine: { lineStyle: { color: theme.axis } },
    axisLabel: { color: theme.label, fontSize: 10 },
    axisTick: { lineStyle: { color: theme.axis } },
    splitLine: { lineStyle: { color: theme.grid } },
  };
}

function tooltipCommon(theme: ChartTheme): EChartsOption["tooltip"] {
  return {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    textStyle: { color: theme.label, fontSize: 11 },
  };
}

function legend(labels: readonly string[], theme: ChartTheme): EChartsOption["legend"] {
  if (labels.length <= 1) return { show: false };
  return {
    show: true,
    type: "scroll",
    bottom: 0,
    textStyle: { color: theme.label, fontSize: 10 },
    itemWidth: 12,
    itemHeight: 8,
  };
}

/** Group a long result into (label → rows) by the `series` column, or a single
 *  unnamed group when there is none. Preserves first-seen order. */
function groupRows(
  result: SqlResult,
  seriesCol: string | undefined,
): { label: string; rows: unknown[][] }[] {
  if (!seriesCol) return [{ label: "", rows: result.rows as unknown[][] }];
  const si = columnIndex(result, seriesCol);
  if (si < 0) return [{ label: "", rows: result.rows as unknown[][] }];
  const groups = new Map<string, unknown[][]>();
  for (const row of result.rows) {
    const key = String(row[si]);
    const arr = groups.get(key) ?? [];
    arr.push(row as unknown[]);
    groups.set(key, arr);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, rows }));
}

/* ── line / bar / area ─────────────────────────────────────────────────── */

function buildCartesian(
  kind: "line" | "bar" | "area",
  result: SqlResult,
  props: Record<string, string>,
  references: readonly ChartReference[],
): EChartsOption | null {
  const theme = chartTheme();
  const xCol = props.x ?? "";
  const xi = columnIndex(result, xCol);
  if (xi < 0) return null;
  const timeX = isDateColumn(result, xCol);
  const yLog = props.yLog === "true";
  const yMax = toNumberOrNull(props.yMax);
  const stacked = kind === "bar" && props.stacked === "true";

  // Series come either from the `series` pivot (one y column) or from multiple
  // y columns (wide). The pivot path groups rows; the wide path reads columns.
  type BuiltSeries = { name: string; data: (number | null)[] | [number, number][] };
  const built: BuiltSeries[] = [];
  let categories: string[] = [];

  if (props.series) {
    const yi = columnIndex(result, yColumns(props)[0] ?? "");
    if (yi < 0) return null;
    const groups = groupRows(result, props.series);
    if (timeX) {
      for (const g of groups) {
        const data: [number, number][] = [];
        for (const row of g.rows) {
          const ms = Date.parse(String(row[xi]));
          const y = toNumberOrNull(row[yi]);
          if (Number.isFinite(ms) && y !== null) data.push([ms, y]);
        }
        built.push({ name: g.label, data });
      }
    } else {
      const cats = new Set<string>();
      for (const row of result.rows) cats.add(String(row[xi]));
      categories = [...cats];
      const catIndex = new Map(categories.map((c, i) => [c, i]));
      for (const g of groups) {
        const data: (number | null)[] = new Array(categories.length).fill(null);
        for (const row of g.rows) {
          const ci = catIndex.get(String(row[xi]));
          if (ci !== undefined) data[ci] = toNumberOrNull(row[yi]);
        }
        built.push({ name: g.label, data });
      }
    }
  } else {
    const yCols = yColumns(props);
    if (yCols.length === 0) return null;
    if (timeX) {
      for (const name of yCols) {
        const yi = columnIndex(result, name);
        if (yi < 0) continue;
        const data: [number, number][] = [];
        for (const row of result.rows) {
          const ms = Date.parse(String(row[xi]));
          const y = toNumberOrNull(row[yi]);
          if (Number.isFinite(ms) && y !== null) data.push([ms, y]);
        }
        built.push({ name, data });
      }
    } else {
      categories = result.rows.map((row) => String(row[xi]));
      for (const name of yCols) {
        const yi = columnIndex(result, name);
        if (yi < 0) continue;
        built.push({ name, data: result.rows.map((row) => toNumberOrNull(row[yi])) });
      }
    }
  }
  if (built.length === 0) return null;

  const refData = references
    .map((r) => ({
      xAxis: timeX ? Date.parse(String(r.value)) : String(r.value),
      label: r.label
        ? { show: true, formatter: r.label, color: theme.label, fontSize: 10 }
        : { show: false },
    }))
    .filter((r) => (timeX ? Number.isFinite(r.xAxis as number) : true));

  const echartsType = kind === "bar" ? "bar" : "line";
  const series = built.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    const base = {
      name: s.name || undefined,
      type: echartsType,
      data: s.data,
      itemStyle: { color },
      lineStyle: kind === "bar" ? undefined : { color, width: 1.5 },
      areaStyle: kind === "area" ? { color, opacity: 0.14 } : undefined,
      symbol: kind === "bar" ? undefined : "none",
      stack: stacked ? "total" : undefined,
      emphasis: { focus: "series" as const },
    };
    if (i === 0 && refData.length > 0) {
      return {
        ...base,
        markLine: {
          symbol: "none",
          lineStyle: { color: theme.ref, type: "dashed" as const, width: 1 },
          data: refData,
        },
      };
    }
    return base;
  });

  return {
    color: [...PALETTE],
    grid: baseGrid(),
    tooltip: { trigger: "axis", ...tooltipCommon(theme) },
    legend: legend(built.map((s) => s.name), theme),
    xAxis: {
      type: timeX ? "time" : "category",
      data: timeX ? undefined : categories,
      boundaryGap: kind === "bar",
      ...axisCommon(theme),
      splitLine: { show: false },
    },
    yAxis: {
      type: yLog ? "log" : "value",
      max: yMax ?? undefined,
      ...axisCommon(theme),
    },
    series,
  } as EChartsOption;
}

/* ── scatter / bubble ──────────────────────────────────────────────────── */

function buildScatter(
  result: SqlResult,
  props: Record<string, string>,
  bubble: boolean,
): EChartsOption | null {
  const theme = chartTheme();
  const xCol = props.x ?? "";
  const yCol = yColumns(props)[0] ?? props.y ?? "";
  const xi = columnIndex(result, xCol);
  const yi = columnIndex(result, yCol);
  if (xi < 0 || yi < 0) return null;
  const timeX = isDateColumn(result, xCol);
  const sizeCol = props.size ?? "";
  const sizeI = bubble ? columnIndex(result, sizeCol) : -1;
  const basePoint = toNumberOrNull(props.pointSize) ?? (bubble ? 12 : 8);

  // Scale bubble sizes into [6, 40] against the size column's span.
  let sizeMin = Infinity;
  let sizeMax = -Infinity;
  if (sizeI >= 0) {
    for (const row of result.rows) {
      const s = toNumberOrNull(row[sizeI]);
      if (s === null) continue;
      sizeMin = Math.min(sizeMin, s);
      sizeMax = Math.max(sizeMax, s);
    }
  }
  const sizeSpan = sizeMax - sizeMin || 1;
  const symbolSize = (row: unknown[]): number => {
    if (sizeI < 0) return basePoint;
    const s = toNumberOrNull(row[sizeI]);
    if (s === null) return 6;
    return 6 + ((s - sizeMin) / sizeSpan) * 34;
  };

  const groups = groupRows(result, props.series);
  const series = groups.map((g, i) => {
    const color = PALETTE[i % PALETTE.length];
    const data = g.rows
      .map((row) => {
        const x = timeX ? Date.parse(String(row[xi])) : toNumberOrNull(row[xi]);
        const y = toNumberOrNull(row[yi]);
        if (x === null || y === null || !Number.isFinite(x)) return null;
        return { value: [x, y], symbolSize: symbolSize(row) };
      })
      .filter((p): p is { value: number[]; symbolSize: number } => p !== null);
    return {
      name: g.label || undefined,
      type: "scatter" as const,
      data,
      itemStyle: { color, opacity: 0.8 },
      emphasis: { focus: "series" as const },
    };
  });

  return {
    color: [...PALETTE],
    grid: baseGrid(),
    tooltip: { trigger: "item", ...tooltipCommon(theme) },
    legend: legend(groups.map((g) => g.label), theme),
    xAxis: { type: timeX ? "time" : "value", scale: true, ...axisCommon(theme), splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...axisCommon(theme) },
    series,
  } as EChartsOption;
}

/* ── histogram ─────────────────────────────────────────────────────────── */

function buildHistogram(result: SqlResult, props: Record<string, string>): EChartsOption | null {
  const theme = chartTheme();
  const col = props.x ?? props.value ?? "";
  const ci = columnIndex(result, col);
  if (ci < 0) return null;
  const values: number[] = [];
  for (const row of result.rows) {
    const n = toNumberOrNull(row[ci]);
    if (n !== null) values.push(n);
  }
  if (values.length === 0) return null;
  const bins = Math.max(1, Math.min(200, Math.round(toNumberOrNull(props.bins) ?? 20)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let b = Math.floor((v - min) / width);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b] += 1;
  }
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : Number(n.toPrecision(3)).toString());
  const labels = counts.map((_, i) => `${fmt(min + i * width)}–${fmt(min + (i + 1) * width)}`);

  return {
    color: [...PALETTE],
    grid: baseGrid(),
    tooltip: { trigger: "axis", ...tooltipCommon(theme) },
    legend: { show: false },
    xAxis: { type: "category", data: labels, ...axisCommon(theme), splitLine: { show: false } },
    yAxis: { type: "value", ...axisCommon(theme) },
    series: [
      { type: "bar", data: counts, itemStyle: { color: PALETTE[0] }, barCategoryGap: "8%" },
    ],
  } as EChartsOption;
}

/* ── heatmap ───────────────────────────────────────────────────────────── */

function buildHeatmap(result: SqlResult, props: Record<string, string>): EChartsOption | null {
  const theme = chartTheme();
  const xi = columnIndex(result, props.x ?? "");
  const yi = columnIndex(result, props.y ?? "");
  const vi = columnIndex(result, props.value ?? "");
  if (xi < 0 || yi < 0 || vi < 0) return null;
  const xCats: string[] = [];
  const yCats: string[] = [];
  const xIndex = new Map<string, number>();
  const yIndex = new Map<string, number>();
  const data: [number, number, number][] = [];
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const row of result.rows) {
    const xk = String(row[xi]);
    const yk = String(row[yi]);
    const v = toNumberOrNull(row[vi]);
    if (v === null) continue;
    if (!xIndex.has(xk)) {
      xIndex.set(xk, xCats.length);
      xCats.push(xk);
    }
    if (!yIndex.has(yk)) {
      yIndex.set(yk, yCats.length);
      yCats.push(yk);
    }
    data.push([xIndex.get(xk)!, yIndex.get(yk)!, v]);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  if (data.length === 0) return null;

  return {
    grid: { left: 60, right: 16, top: 24, bottom: 60, containLabel: true },
    tooltip: { trigger: "item", ...tooltipCommon(theme) },
    xAxis: { type: "category", data: xCats, ...axisCommon(theme), splitLine: { show: false } },
    yAxis: { type: "category", data: yCats, ...axisCommon(theme), splitLine: { show: false } },
    visualMap: {
      min: Number.isFinite(vMin) ? vMin : 0,
      max: Number.isFinite(vMax) ? vMax : 1,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      textStyle: { color: theme.label, fontSize: 10 },
      inRange: { color: ["#0b2447", "#2563eb", "#f97316", "#facc15"] },
    },
    series: [
      {
        type: "heatmap",
        data,
        emphasis: { itemStyle: { borderColor: theme.label, borderWidth: 1 } },
      },
    ],
  } as EChartsOption;
}

/* ── funnel ────────────────────────────────────────────────────────────── */

function buildFunnel(result: SqlResult, props: Record<string, string>): EChartsOption | null {
  const theme = chartTheme();
  const li = columnIndex(result, props.label ?? "");
  const vi = columnIndex(result, props.value ?? "");
  if (li < 0 || vi < 0) return null;
  const data = result.rows
    .map((row) => ({ name: String(row[li]), value: toNumberOrNull(row[vi]) ?? 0 }))
    .filter((d) => d.value > 0);
  if (data.length === 0) return null;

  return {
    color: [...PALETTE],
    tooltip: { trigger: "item", ...tooltipCommon(theme) },
    legend: legend(data.map((d) => d.name), theme),
    series: [
      {
        type: "funnel",
        left: "10%",
        right: "10%",
        top: 24,
        bottom: 24,
        sort: "descending",
        label: { color: theme.label, fontSize: 10 },
        data,
      },
    ],
  } as EChartsOption;
}

/* ── sankey ────────────────────────────────────────────────────────────── */

function buildSankey(result: SqlResult, props: Record<string, string>): EChartsOption | null {
  const theme = chartTheme();
  const si = columnIndex(result, props.source ?? "");
  const ti = columnIndex(result, props.target ?? "");
  const vi = columnIndex(result, props.value ?? "");
  if (si < 0 || ti < 0 || vi < 0) return null;
  const nodeNames = new Set<string>();
  const links: { source: string; target: string; value: number }[] = [];
  for (const row of result.rows) {
    const source = String(row[si]);
    const target = String(row[ti]);
    const value = toNumberOrNull(row[vi]);
    if (value === null) continue;
    nodeNames.add(source);
    nodeNames.add(target);
    links.push({ source, target, value });
  }
  if (links.length === 0) return null;

  return {
    color: [...PALETTE],
    tooltip: { trigger: "item", ...tooltipCommon(theme) },
    series: [
      {
        type: "sankey",
        left: 8,
        right: 120,
        top: 16,
        bottom: 16,
        data: [...nodeNames].map((name) => ({ name })),
        links,
        label: { color: theme.label, fontSize: 10 },
        lineStyle: { color: "gradient", opacity: 0.4 },
        emphasis: { focus: "adjacency" },
      },
    ],
  } as EChartsOption;
}

/** Dispatch a report chart kind to its option builder. Returns null when the
 *  named columns are absent, so the registry can show an honest notice. */
export function buildChartOption(
  kind: ReportChartKind,
  result: SqlResult,
  props: Record<string, string>,
  references: readonly ChartReference[],
): EChartsOption | null {
  switch (kind) {
    case "line":
    case "bar":
    case "area":
      return buildCartesian(kind, result, props, references);
    case "scatter":
      return buildScatter(result, props, false);
    case "bubble":
      return buildScatter(result, props, true);
    case "histogram":
      return buildHistogram(result, props);
    case "heatmap":
      return buildHeatmap(result, props);
    case "funnel":
      return buildFunnel(result, props);
    case "sankey":
      return buildSankey(result, props);
  }
}
