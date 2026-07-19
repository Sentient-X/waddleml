/* The report component registry — one file mapping the Evidence.dev component
   names the waddle report dialect actually uses onto @sx/ui + uPlot. This is a
   deliberately small subset (the fusion brief's "do not port the full
   inventory"); unknown component names render as an honest inline notice rather
   than silently vanishing.

   Every component reads from the render's per-query results (keyed by the SQL
   fence name). Props arrive verbatim as strings — this registry owns their
   interpretation. */

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { DataTable, KpiStat, cn, type DataTableColumn } from "@sx/ui";

import type { RenderBlock, SqlResult } from "@/api/types";
import { alignForType, applyFmt, formatByType } from "@/lib/reportFormat";
import { XYChart, type ChartKind, type ReferenceLine, type XySeries } from "./XYChart";

export interface RenderContext {
  results: Record<string, SqlResult>;
  renderChildren: (blocks: readonly RenderBlock[]) => ReactNode;
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
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Date columns arrive as ISO strings; a time x-axis wants epoch seconds. */
function toXOrNull(value: unknown, xIsDate: boolean): number | null {
  if (xIsDate && typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return toNumberOrNull(value);
}

/** Missing/empty query → an inline notice; keeps the component honest. */
function Missing({ what }: { what: string }) {
  return <span className="text-xs text-muted-foreground">[{what}]</span>;
}

function BigValue({ result, props }: { result?: SqlResult; props: Props }) {
  const col = props.value ?? props.column ?? "";
  const raw = firstCell(result, col);
  const type = result ? result.column_types[columnIndex(result, col)] : undefined;
  const text = props.fmt ? applyFmt(raw, props.fmt) : formatByType(raw, type);
  return <KpiStat label={props.title ?? col} value={text} />;
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

/** Build the series set for a chart from a long or wide result. */
function buildSeries(result: SqlResult, props: Props): XySeries[] {
  const xi = columnIndex(result, props.x ?? "");
  if (xi < 0) return [];
  const xIsDate = result.column_types[xi] === "date";
  const yCols = (props.y ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Pivot long → wide by the `series` column: one series per distinct value.
  if (props.series) {
    const si = columnIndex(result, props.series);
    const yi = columnIndex(result, yCols[0] ?? "");
    if (si < 0 || yi < 0) return [];
    const groups = new Map<string, { x: number; y: number }[]>();
    for (const row of result.rows) {
      const x = toXOrNull(row[xi], xIsDate);
      const y = toNumberOrNull(row[yi]);
      if (x === null || y === null) continue;
      const key = String(row[si]);
      const arr = groups.get(key) ?? [];
      arr.push({ x, y });
      groups.set(key, arr);
    }
    return [...groups.entries()].map(([label, points]) => ({ label, points }));
  }

  // Wide: each y column is its own series.
  const out: XySeries[] = [];
  for (const name of yCols) {
    const yi = columnIndex(result, name);
    if (yi < 0) continue;
    const points: { x: number; y: number }[] = [];
    for (const row of result.rows) {
      const x = toXOrNull(row[xi], xIsDate);
      const y = toNumberOrNull(row[yi]);
      if (x !== null && y !== null) points.push({ x, y });
    }
    out.push({ label: name, points });
  }
  return out;
}

/** ReferenceLine children draw vertical annotations from their own query. */
function collectReferences(
  children: readonly RenderBlock[] | undefined,
  ctx: RenderContext,
): { refs: ReferenceLine[]; annotations: string[] } {
  const refs: ReferenceLine[] = [];
  const annotations: string[] = [];
  for (const child of children ?? []) {
    if (child.kind !== "component" || child.component !== "ReferenceLine") continue;
    const cprops = child.props ?? {};
    const result = child.query ? ctx.results[child.query] : undefined;
    if (!result) continue;
    const xi = columnIndex(result, cprops.x ?? "");
    if (xi < 0) continue;
    for (const row of result.rows) {
      const x = toNumberOrNull(row[xi]);
      if (x === null) continue;
      refs.push({ x, label: cprops.label });
      annotations.push(`${cprops.label ? `${cprops.label}: ` : ""}${x}`);
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
  kind: ChartKind;
  children?: readonly RenderBlock[];
  ctx: RenderContext;
}) {
  if (!result) return <Missing what="chart: no data" />;
  const series = buildSeries(result, props);
  const { refs, annotations } = collectReferences(children, ctx);
  const yMax = props.yMax !== undefined ? Number(props.yMax) : undefined;
  const xIndex = columnIndex(result, props.x ?? "");
  const timeX = xIndex >= 0 && result.column_types[xIndex] === "date";
  return (
    <div className="rounded-lg border p-3">
      {props.title ? (
        <div className="mb-1 text-xs font-medium text-muted-foreground">{props.title}</div>
      ) : null}
      <XYChart
        series={series}
        kind={kind}
        yLog={props.yLog === "true"}
        yMax={Number.isFinite(yMax) ? yMax : undefined}
        references={refs}
        timeX={timeX}
      />
      {annotations.length > 0 ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Reference lines: {annotations.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

interface ColumnSpec {
  id: string;
  title?: string;
  fmt?: string;
  align?: "left" | "right" | "center";
}

function columnSpecs(children: readonly RenderBlock[] | undefined): ColumnSpec[] {
  const specs: ColumnSpec[] = [];
  for (const child of children ?? []) {
    if (child.kind !== "component" || child.component !== "Column") continue;
    const p = child.props ?? {};
    if (!p.id) continue;
    const align =
      p.align === "left" || p.align === "right" || p.align === "center" ? p.align : undefined;
    specs.push({ id: p.id, title: p.title, fmt: p.fmt, align });
  }
  return specs;
}

interface TableRow {
  i: number;
  cells: unknown[];
}

function ReportTable({ result, children }: { result?: SqlResult; children?: readonly RenderBlock[] }) {
  if (!result) return <Missing what="table: no data" />;
  const specs = columnSpecs(children);
  // Column children pick + order the columns; none → all columns as-is.
  const chosen: ColumnSpec[] =
    specs.length > 0 ? specs : result.columns.map((id) => ({ id }));

  const columns: DataTableColumn<TableRow>[] = [];
  for (const spec of chosen) {
    const idx = columnIndex(result, spec.id);
    if (idx < 0) continue;
    const type = result.column_types[idx];
    columns.push({
      key: spec.id,
      header: spec.title ?? spec.id,
      align: spec.align ?? alignForType(type),
      mono: type === "number",
      cell: (row: TableRow) => {
        const value = row.cells[idx];
        if (value === null || value === undefined) {
          return <span className="text-muted-foreground">—</span>;
        }
        return spec.fmt ? applyFmt(value, spec.fmt) : formatByType(value, type);
      },
    });
  }

  const rows: TableRow[] = result.rows.map((cells, i) => ({ i, cells }));
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.i} stickyHeader />;
}

function Grid({
  props,
  children,
  ctx,
}: {
  props: Props;
  children?: readonly RenderBlock[];
  ctx: RenderContext;
}) {
  const cols = Math.max(1, Math.min(6, Number(props.cols) || 2));
  return (
    <div
      className={cn("grid gap-3")}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {ctx.renderChildren(children ?? [])}
    </div>
  );
}

function Details({
  props,
  children,
  ctx,
}: {
  props: Props;
  children?: readonly RenderBlock[];
  ctx: RenderContext;
}) {
  return (
    <details className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{props.title ?? "Details"}</summary>
      <div className="mt-2 flex flex-col gap-3">{ctx.renderChildren(children ?? [])}</div>
    </details>
  );
}

/** Render one component block. `ReferenceLine`/`Column` are consumed by their
 *  parent, so they render nothing on their own. */
export function ReportComponent({ block, ctx }: { block: RenderBlock; ctx: RenderContext }) {
  const name = block.component ?? "";
  const props = block.props ?? {};
  const result = block.query ? ctx.results[block.query] : undefined;

  switch (name) {
    case "BigValue":
      return <BigValue result={result} props={props} />;
    case "Value":
      return <InlineValue result={result} props={props} />;
    case "LineChart":
      return <Chart result={result} props={props} kind="line" children={block.children} ctx={ctx} />;
    case "BarChart":
      return <Chart result={result} props={props} kind="bar" children={block.children} ctx={ctx} />;
    case "AreaChart":
      return <Chart result={result} props={props} kind="area" children={block.children} ctx={ctx} />;
    case "DataTable":
      return <ReportTable result={result} children={block.children} />;
    case "Grid":
      return <Grid props={props} children={block.children} ctx={ctx} />;
    case "Details":
      return <Details props={props} children={block.children} ctx={ctx} />;
    case "ReferenceLine":
    case "Column":
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
