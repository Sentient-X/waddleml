/* The report component registry — one file mapping the Evidence.dev component
   names the waddle report dialect uses onto @sx/ui + ECharts. Deliberately a
   curated subset, raised to Evidence-grade fidelity (value tiles with
   sparkline/comparison, table content-types, param-bound inputs, tabbed
   layout). Charts are built in charts.ts and rendered by the lazy EChart;
   inputs live in inputs.tsx. Unknown component names render an honest inline
   notice rather than silently vanishing.

   Every component reads from the render's per-query results (keyed by the SQL
   fence name). Props arrive verbatim as strings — this registry owns their
   interpretation. */

import { Suspense, lazy, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp } from "lucide-react";
import { DataTable, KpiStat, Sparkline, cn, type DataTableColumn } from "@sx/ui";

import type { RenderBlock, SqlResult } from "@/api/types";
import { alignForType, applyFmt, formatByType } from "@/lib/reportFormat";
import { buildChartOption, segmentTrackCount, type ChartReference, type ReportChartKind } from "./charts";
import {
  ButtonGroup,
  Dropdown,
  INPUT_COMPONENTS,
  Slider,
  TextInput,
  type InputRenderProps,
} from "./inputs";

// EChart pulls echarts via dynamic import; lazy-loading the wrapper too keeps
// the whole charting path out of the main chunk.
const EChart = lazy(() => import("./EChart").then((m) => ({ default: m.EChart })));

export interface RenderContext {
  results: Record<string, SqlResult>;
  renderChildren: (blocks: readonly RenderBlock[]) => ReactNode;
  /** Effective report params (server-echoed), driving input current values. */
  params: Record<string, string>;
  /** Present only on interactive surfaces; absent → inputs render disabled. */
  onParamChange?: (name: string, value: string) => void;
}

type Props = Record<string, string>;

function columnIndex(result: SqlResult, name: string): number {
  return result.columns.indexOf(name);
}

/** First cell of a named column across the result's first row. */
function firstCell(result: SqlResult | undefined, column: string): unknown {
  if (!result || result.rows.length === 0) return undefined;
  const i = columnIndex(result, column);
  return i < 0 ? undefined : result.rows[0][i];
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Every numeric value of a named column, in row order (for sparklines). */
function numberColumn(result: SqlResult | undefined, column: string): number[] {
  if (!result) return [];
  const i = columnIndex(result, column);
  if (i < 0) return [];
  const out: number[] = [];
  for (const row of result.rows) {
    const n = toNumberOrNull(row[i]);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Missing/empty query → an inline notice; keeps the component honest. */
function Missing({ what }: { what: string }) {
  return <span className="text-xs text-muted-foreground">[{what}]</span>;
}

/* ── delta rendering — one law shared by Delta, BigValue comparison, and the
      DataTable `delta` content-type. Up is good unless downIsGood flips it. ── */

type DeltaTone = "positive" | "negative" | "neutral";

interface DeltaParts {
  text: string;
  tone: DeltaTone;
  dir: "up" | "down" | "flat";
}

function deltaParts(value: unknown, fmt: string | undefined, downIsGood: boolean): DeltaParts {
  const n = toNumberOrNull(value);
  if (n === null) return { text: formatByType(value, undefined), tone: "neutral", dir: "flat" };
  const text = fmt ? applyFmt(Math.abs(n), fmt) : formatByType(Math.abs(n), "number");
  if (n === 0) return { text, tone: "neutral", dir: "flat" };
  const up = n > 0;
  const good = up ? !downIsGood : downIsGood;
  return { text, tone: good ? "positive" : "negative", dir: up ? "up" : "down" };
}

const TONE_CLASS: Record<DeltaTone, string> = {
  positive: "text-success",
  negative: "text-destructive",
  neutral: "text-muted-foreground",
};

function DeltaBadge({ parts, colored = true }: { parts: DeltaParts; colored?: boolean }) {
  const Arrow = parts.dir === "up" ? ArrowUp : parts.dir === "down" ? ArrowDown : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono tabular-nums",
        colored && TONE_CLASS[parts.tone],
      )}
    >
      {Arrow ? <Arrow className="h-3 w-3" /> : null}
      {parts.text}
    </span>
  );
}

function Delta({ result, props }: { result?: SqlResult; props: Props }) {
  const col = props.column ?? props.value ?? "";
  const raw = firstCell(result, col);
  const parts = deltaParts(raw, props.fmt, props.downIsGood === "true");
  return <DeltaBadge parts={parts} />;
}

function ReportSparkline({ result, props }: { result?: SqlResult; props: Props }) {
  const data = numberColumn(result, props.column ?? props.value ?? "");
  if (data.length < 2) return <Missing what="sparkline: no data" />;
  const height = toNumberOrNull(props.height) ?? 24;
  return <Sparkline data={data} height={height} className="text-primary" />;
}

function BigValue({ result, props }: { result?: SqlResult; props: Props }) {
  const col = props.value ?? props.column ?? "";
  const raw = firstCell(result, col);
  const type = result ? result.column_types[columnIndex(result, col)] : undefined;
  const text = props.fmt ? applyFmt(raw, props.fmt) : formatByType(raw, type);

  const trend = props.sparkline ? numberColumn(result, props.sparkline) : [];
  let delta: ReactNode = undefined;
  let deltaTone: DeltaTone = "neutral";
  if (props.comparison) {
    const parts = deltaParts(
      firstCell(result, props.comparison),
      props.comparisonFmt,
      props.downIsGood === "true",
    );
    deltaTone = parts.tone;
    delta = <DeltaBadge parts={parts} colored={false} />;
  }

  return (
    <KpiStat
      label={props.title ?? col}
      value={text}
      trend={trend.length >= 2 ? trend : undefined}
      delta={delta}
      deltaTone={deltaTone}
      hint={props.comparisonTitle}
    />
  );
}

function InlineValue({ result, props }: { result?: SqlResult; props: Props }) {
  if (props.value !== undefined && !props.column) {
    return <span className="font-mono tabular-nums">{props.value}</span>;
  }
  const col = props.column ?? props.value ?? "";
  const raw = firstCell(result, col);
  const type = result ? result.column_types[columnIndex(result, col)] : undefined;
  const text = props.fmt ? applyFmt(raw, props.fmt) : formatByType(raw, type);
  return <span className="font-mono tabular-nums">{text}</span>;
}

/* ── charts ────────────────────────────────────────────────────────────── */

/** ReferenceLine children draw vertical annotations from their own query;
 *  each contributes its raw x cell(s), normalized by the chart's axis kind. */
function collectReferences(
  children: readonly RenderBlock[] | undefined,
  ctx: RenderContext,
): { refs: ChartReference[]; annotations: string[] } {
  const refs: ChartReference[] = [];
  const annotations: string[] = [];
  for (const child of children ?? []) {
    if (child.kind !== "component" || child.component !== "ReferenceLine") continue;
    const cprops = child.props ?? {};
    const result = child.query ? ctx.results[child.query] : undefined;
    if (!result) continue;
    const xi = columnIndex(result, cprops.x ?? "");
    if (xi < 0) continue;
    for (const row of result.rows) {
      const value = row[xi];
      if (value === null || value === undefined) continue;
      refs.push({ value, label: cprops.label });
      annotations.push(`${cprops.label ? `${cprops.label}: ` : ""}${String(value)}`);
    }
  }
  return { refs, annotations };
}

function Chart({
  result,
  props,
  kind,
  children,
  ctx,
}: {
  result?: SqlResult;
  props: Props;
  kind: ReportChartKind;
  children?: readonly RenderBlock[];
  ctx: RenderContext;
}) {
  if (!result) return <Missing what="chart: no data" />;
  // Reference lines only apply to the cartesian kinds.
  const cartesian = kind === "line" || kind === "bar" || kind === "area";
  const { refs, annotations } = cartesian
    ? collectReferences(children, ctx)
    : { refs: [], annotations: [] };
  const option = buildChartOption(kind, result, props, refs);
  if (!option) return <Missing what={`chart: columns not found`} />;
  const height = toNumberOrNull(props.height) ?? 240;

  return (
    <div className="rounded-lg border p-3">
      {props.title ? (
        <div className="mb-1 text-xs font-medium text-muted-foreground">{props.title}</div>
      ) : null}
      <Suspense fallback={<div className="h-[240px] animate-pulse rounded bg-muted/30" />}>
        <EChart option={option} height={height} />
      </Suspense>
      {annotations.length > 0 ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Reference lines: {annotations.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

/* ── table ─────────────────────────────────────────────────────────────── */

type ContentType = "bar" | "delta" | "link";

interface ColumnSpec {
  id: string;
  title?: string;
  fmt?: string;
  align?: "left" | "right" | "center";
  contentType?: ContentType;
  barColor?: string;
  href?: string;
  downIsGood: boolean;
  wrap: boolean;
}

function contentTypeOf(v: string | undefined): ContentType | undefined {
  return v === "bar" || v === "delta" || v === "link" ? v : undefined;
}

function columnSpecs(children: readonly RenderBlock[] | undefined): ColumnSpec[] {
  const specs: ColumnSpec[] = [];
  for (const child of children ?? []) {
    if (child.kind !== "component" || child.component !== "Column") continue;
    const p = child.props ?? {};
    if (!p.id) continue;
    const align =
      p.align === "left" || p.align === "right" || p.align === "center" ? p.align : undefined;
    specs.push({
      id: p.id,
      title: p.title,
      fmt: p.fmt,
      align,
      contentType: contentTypeOf(p.contentType),
      barColor: p.barColor,
      href: p.href,
      downIsGood: p.downIsGood === "true",
      wrap: p.wrap === "true",
    });
  }
  return specs;
}

interface TableRow {
  i: number;
  cells: unknown[];
}

/** Absolute max of a numeric column, for scaling `bar` content-type cells. */
function columnAbsMax(result: SqlResult, idx: number): number {
  let max = 0;
  for (const row of result.rows) {
    const n = toNumberOrNull(row[idx]);
    if (n !== null) max = Math.max(max, Math.abs(n));
  }
  return max || 1;
}

function BarCell({ value, max, fmt, color }: { value: unknown; max: number; fmt?: string; color?: string }) {
  const n = toNumberOrNull(value);
  const pct = n === null ? 0 : Math.min(100, (Math.abs(n) / max) * 100);
  const text = fmt ? applyFmt(value, fmt) : formatByType(value, "number");
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="relative h-2 w-16 overflow-hidden rounded-sm bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${pct}%`, backgroundColor: color ?? "hsl(var(--primary))" }}
        />
      </span>
      <span className="font-mono tabular-nums">{text}</span>
    </span>
  );
}

function ReportTable({ result, props, children }: { result?: SqlResult; props: Props; children?: readonly RenderBlock[] }) {
  const [filter, setFilter] = useState("");
  if (!result) return <Missing what="table: no data" />;
  const specs = columnSpecs(children);
  const chosen: ColumnSpec[] = specs.length > 0 ? specs : result.columns.map((id) => ({ id, downIsGood: false, wrap: false }));
  const searchable = props.search === "true";
  const limit = toNumberOrNull(props.limit);

  const columns: DataTableColumn<TableRow>[] = [];
  for (const spec of chosen) {
    const idx = columnIndex(result, spec.id);
    if (idx < 0) continue;
    const type = result.column_types[idx];
    const barMax = spec.contentType === "bar" ? columnAbsMax(result, idx) : 1;
    columns.push({
      key: spec.id,
      header: spec.title ?? spec.id,
      align: spec.align ?? (spec.contentType === "bar" ? "right" : alignForType(type)),
      mono: type === "number" && !spec.contentType,
      cellClassName: spec.wrap ? "whitespace-normal" : undefined,
      cell: (row: TableRow) => {
        const value = row.cells[idx];
        if ((value === null || value === undefined) && spec.contentType !== "delta") {
          return <span className="text-muted-foreground">—</span>;
        }
        if (spec.contentType === "delta") {
          return <DeltaBadge parts={deltaParts(value, spec.fmt, spec.downIsGood)} />;
        }
        if (spec.contentType === "bar") {
          return <BarCell value={value} max={barMax} fmt={spec.fmt} color={spec.barColor} />;
        }
        if (spec.contentType === "link") {
          const href = spec.href ? String(row.cells[columnIndex(result, spec.href)] ?? "") : String(value);
          const text = spec.fmt ? applyFmt(value, spec.fmt) : formatByType(value, type);
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {text}
            </a>
          );
        }
        return spec.fmt ? applyFmt(value, spec.fmt) : formatByType(value, type);
      },
    });
  }

  let rows: TableRow[] = result.rows.map((cells, i) => ({ i, cells }));
  const total = rows.length;
  if (searchable && filter.trim()) {
    const needle = filter.trim().toLowerCase();
    rows = rows.filter((r) => r.cells.some((c) => c !== null && c !== undefined && String(c).toLowerCase().includes(needle)));
  }
  const capped = limit !== null && limit >= 0 ? rows.slice(0, limit) : rows;

  return (
    <div className="flex flex-col gap-2">
      {searchable ? (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows…"
          className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-xs"
        />
      ) : null}
      <DataTable columns={columns} rows={capped} rowKey={(r) => r.i} stickyHeader />
      {capped.length < rows.length || rows.length < total ? (
        <span className="text-[11px] text-muted-foreground">
          showing {capped.length} of {total} rows
        </span>
      ) : null}
    </div>
  );
}

/* ── layout ────────────────────────────────────────────────────────────── */

function Grid({ props, children, ctx }: { props: Props; children?: readonly RenderBlock[]; ctx: RenderContext }) {
  const cols = Math.max(1, Math.min(6, Number(props.cols) || 2));
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {ctx.renderChildren(children ?? [])}
    </div>
  );
}

function Details({ props, children, ctx }: { props: Props; children?: readonly RenderBlock[]; ctx: RenderContext }) {
  return (
    <details className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{props.title ?? "Details"}</summary>
      <div className="mt-2 flex flex-col gap-3">{ctx.renderChildren(children ?? [])}</div>
    </details>
  );
}

function Tabs({ children, ctx }: { children?: readonly RenderBlock[]; ctx: RenderContext }) {
  const tabs = (children ?? []).filter(
    (c) => c.kind === "component" && c.component === "Tab",
  );
  const [active, setActive] = useState(0);
  if (tabs.length === 0) return null;
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex w-fit rounded-md border border-input p-0.5">
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            className={cn(
              "rounded px-3 py-1 text-xs transition-colors",
              i === active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {t.props?.title ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3">{ctx.renderChildren(current.children ?? [])}</div>
    </div>
  );
}

const ALERT_CLASS: Record<string, string> = {
  info: "border-primary/40 bg-primary/5 text-foreground",
  warning: "border-warning/40 bg-warning/5 text-foreground",
  error: "border-destructive/40 bg-destructive/5 text-foreground",
};

function Alert({ props, children, ctx }: { props: Props; children?: readonly RenderBlock[]; ctx: RenderContext }) {
  const status = props.status === "warning" || props.status === "error" ? props.status : "info";
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-sm", ALERT_CLASS[status])}>
      <div className="flex flex-col gap-2">{ctx.renderChildren(children ?? [])}</div>
    </div>
  );
}

function ReportImage({ props }: { props: Props }) {
  if (!props.src) return <Missing what="image: no src" />;
  const width = toNumberOrNull(props.width);
  return (
    <img
      src={props.src}
      alt={props.alt ?? ""}
      width={width ?? undefined}
      className="rounded-lg border"
    />
  );
}

/* ── inputs ────────────────────────────────────────────────────────────── */

function inputRenderProps(result: SqlResult | undefined, props: Props, ctx: RenderContext): InputRenderProps {
  return { props, result, params: ctx.params, onParamChange: ctx.onParamChange };
}

/** Walk a block tree for the param names bound by input components — the pages
 *  use it to drop those params from the crude fallback bar. */
export function reportInputNames(blocks: readonly RenderBlock[], acc = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.kind === "component" && b.component && INPUT_COMPONENTS.has(b.component)) {
      const name = b.props?.name;
      if (name) acc.add(name);
    }
    if (b.children) reportInputNames(b.children, acc);
  }
  return acc;
}

/** Render one component block. `ReferenceLine`/`Column`/`Tab` are consumed by
 *  their parent, so they render nothing on their own. */
export function ReportComponent({ block, ctx }: { block: RenderBlock; ctx: RenderContext }) {
  const name = block.component ?? "";
  const props = block.props ?? {};
  const result = block.query ? ctx.results[block.query] : undefined;

  switch (name) {
    case "BigValue":
      return <BigValue result={result} props={props} />;
    case "Value":
      return <InlineValue result={result} props={props} />;
    case "Delta":
      return <Delta result={result} props={props} />;
    case "Sparkline":
      return <ReportSparkline result={result} props={props} />;
    case "LineChart":
      return <Chart result={result} props={props} kind="line" children={block.children} ctx={ctx} />;
    case "BarChart":
      return <Chart result={result} props={props} kind="bar" children={block.children} ctx={ctx} />;
    case "AreaChart":
      return <Chart result={result} props={props} kind="area" children={block.children} ctx={ctx} />;
    case "ScatterPlot":
      return <Chart result={result} props={props} kind="scatter" children={block.children} ctx={ctx} />;
    case "BubbleChart":
      return <Chart result={result} props={props} kind="bubble" children={block.children} ctx={ctx} />;
    case "Histogram":
      return <Chart result={result} props={props} kind="histogram" children={block.children} ctx={ctx} />;
    case "Heatmap":
      return <Chart result={result} props={props} kind="heatmap" children={block.children} ctx={ctx} />;
    case "FunnelChart":
      return <Chart result={result} props={props} kind="funnel" children={block.children} ctx={ctx} />;
    case "SankeyDiagram":
      return <Chart result={result} props={props} kind="sankey" children={block.children} ctx={ctx} />;
    case "SegmentTimeline": {
      // Default height scales with the lane count so N tracks stay readable.
      const lanes = result ? segmentTrackCount(result, props) : 1;
      const sized = { ...props, height: props.height ?? String(Math.min(480, 64 + lanes * 34)) };
      return <Chart result={result} props={sized} kind="segment" children={block.children} ctx={ctx} />;
    }
    case "DataTable":
      return <ReportTable result={result} props={props} children={block.children} />;
    case "Dropdown":
      return <Dropdown {...inputRenderProps(result, props, ctx)} />;
    case "ButtonGroup":
      return <ButtonGroup {...inputRenderProps(result, props, ctx)} />;
    case "TextInput":
      return <TextInput {...inputRenderProps(result, props, ctx)} />;
    case "Slider":
      return <Slider {...inputRenderProps(result, props, ctx)} />;
    case "Grid":
      return <Grid props={props} children={block.children} ctx={ctx} />;
    case "Details":
      return <Details props={props} children={block.children} ctx={ctx} />;
    case "Tabs":
      return <Tabs children={block.children} ctx={ctx} />;
    case "Alert":
      return <Alert props={props} children={block.children} ctx={ctx} />;
    case "Image":
      return <ReportImage props={props} />;
    case "ReferenceLine":
    case "Column":
    case "Tab":
      return null; // consumed by the parent component
    default:
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          Unsupported component <span className="font-mono">{name || "?"}</span>
        </div>
      );
  }
}
