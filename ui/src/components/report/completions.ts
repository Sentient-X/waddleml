/* Report-editor autocomplete — one file. Two things live here:

   1. `sqlSchema(datasets)` — the table/column map handed to `@codemirror/lang-sql`
      so identifiers inside ```sql fences complete natively (the substrate views
      plus every open-datasets-door view for this org).

   2. `reportCompletionSource` — a CodeMirror completion source (attached to both
      the markdown and the nested-SQL language data) that fires on:
        • `<`  → component tags, inserted as prop snippets (data=, never query=).
        • `${` → query ids parsed live from the draft's ```sql fences, and `params.`.

   Keyword completion for SQL comes from lang-sql itself; this only adds what the
   report dialect layers on top of plain SQL + markdown. */

import { snippetCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/** The always-present sandbox views, with their columns for column-level hints. */
const SUBSTRATE_VIEWS: Record<string, string[]> = {
  runs: [
    "run_id",
    "project",
    "name",
    "state",
    "group_name",
    "job_type",
    "config",
    "summary",
    "commit_sha",
    "created_at",
    "started_at",
    "finished_at",
  ],
  metrics: ["run_id", "metric_name", "step", "ts", "value", "rank", "node_id", "attempt"],
  logs: ["run_id", "ts", "level", "source", "message"],
};

/** The lang-sql `schema` map: substrate views (with columns) plus dataset views
 *  (name only — a published dataset's columns are not known to the client). */
export function sqlSchema(datasets: readonly string[]): Record<string, string[]> {
  const schema: Record<string, string[]> = { ...SUBSTRATE_VIEWS };
  for (const d of datasets) if (!(d in schema)) schema[d] = [];
  return schema;
}

/** Component vocabulary → the snippet inserted when picked. `data={…}` is the
 *  data prop (never `query=`); `${name}` markers are editable snippet fields. */
const COMPONENTS: { label: string; detail: string; template: string }[] = [
  // ── value tiles ──────────────────────────────────────────────────────────
  {
    label: "<BigValue",
    detail: "KPI stat (+sparkline/comparison)",
    template:
      '<BigValue data={${query}} value="${column}" title="${title}" fmt="${#,##0}" sparkline="${sparkCol}" comparison="${deltaCol}" comparisonTitle="${vs}" comparisonFmt="${0.0%}" downIsGood="${false}" />',
  },
  {
    label: "<Value",
    detail: "inline scalar",
    template: '<Value data={${query}} column="${column}" fmt="${fmt}" />',
  },
  {
    label: "<Delta",
    detail: "colored ± with arrow",
    template: '<Delta data={${query}} column="${column}" fmt="${0.0%}" downIsGood="${false}" />',
  },
  {
    label: "<Sparkline",
    detail: "inline trend line",
    template: '<Sparkline data={${query}} column="${column}" height="${24}" />',
  },
  // ── charts ───────────────────────────────────────────────────────────────
  {
    label: "<LineChart",
    detail: "time / step series",
    template:
      '<LineChart data={${query}} x="${x}" y="${y}" series="${series}" yLog="${false}" title="${title}" />',
  },
  {
    label: "<BarChart",
    detail: "categorical bars",
    template: '<BarChart data={${query}} x="${x}" y="${y}" stacked="${false}" title="${title}" />',
  },
  {
    label: "<AreaChart",
    detail: "filled series",
    template: '<AreaChart data={${query}} x="${x}" y="${y}" series="${series}" title="${title}" />',
  },
  {
    label: "<ScatterPlot",
    detail: "x/y points",
    template:
      '<ScatterPlot data={${query}} x="${x}" y="${y}" series="${series}" pointSize="${8}" title="${title}" />',
  },
  {
    label: "<BubbleChart",
    detail: "scatter sized by column",
    template:
      '<BubbleChart data={${query}} x="${x}" y="${y}" size="${sizeCol}" series="${series}" title="${title}" />',
  },
  {
    label: "<Histogram",
    detail: "binned distribution",
    template: '<Histogram data={${query}} x="${column}" bins="${20}" title="${title}" />',
  },
  {
    label: "<Heatmap",
    detail: "x/y/value matrix",
    template: '<Heatmap data={${query}} x="${x}" y="${y}" value="${value}" title="${title}" />',
  },
  {
    label: "<FunnelChart",
    detail: "label/value funnel",
    template: '<FunnelChart data={${query}} label="${label}" value="${value}" title="${title}" />',
  },
  {
    label: "<SankeyDiagram",
    detail: "source/target/value flow",
    template:
      '<SankeyDiagram data={${query}} source="${source}" target="${target}" value="${value}" title="${title}" />',
  },
  {
    label: "<ReferenceLine",
    detail: "chart annotation (child)",
    template: '<ReferenceLine data={${query}} x="${x}" label="${label}" />',
  },
  // ── table ────────────────────────────────────────────────────────────────
  {
    label: "<DataTable",
    detail: "tabular result",
    template: '<DataTable data={${query}} search="${false}" limit="${50}" />',
  },
  {
    label: "<Column",
    detail: "DataTable column (child)",
    template:
      '<Column id="${id}" title="${title}" fmt="${fmt}" align="${left}" contentType="${bar}" barColor="${#2563eb}" href="${urlCol}" downIsGood="${false}" wrap="${false}" />',
  },
  // ── inputs (name= binds a report param; defaultValue= seeds it) ───────────
  {
    label: "<Dropdown",
    detail: "param-bound select",
    template: '<Dropdown name="${param}" data={${query}} value="${valueCol}" label="${labelCol}" defaultValue="${default}" title="${title}" />',
  },
  {
    label: "<ButtonGroup",
    detail: "param-bound segmented buttons",
    template: '<ButtonGroup name="${param}" options="${a,b,c}" defaultValue="${a}" title="${title}" />',
  },
  {
    label: "<TextInput",
    detail: "param-bound text (debounced)",
    template: '<TextInput name="${param}" placeholder="${placeholder}" defaultValue="${}" title="${title}" />',
  },
  {
    label: "<Slider",
    detail: "param-bound range (debounced)",
    template: '<Slider name="${param}" min="${0}" max="${100}" step="${1}" defaultValue="${50}" title="${title}" />',
  },
  // ── layout ───────────────────────────────────────────────────────────────
  {
    label: "<Grid",
    detail: "columns layout",
    template: '<Grid cols="2">\n  ${}\n</Grid>',
  },
  {
    label: "<Details",
    detail: "collapsible section",
    template: '<Details title="${title}">\n  ${}\n</Details>',
  },
  {
    label: "<Tabs",
    detail: "tabbed sections",
    template: '<Tabs>\n  <Tab title="${first}">\n    ${}\n  </Tab>\n  <Tab title="${second}">\n  </Tab>\n</Tabs>',
  },
  {
    label: "<Tab",
    detail: "one tab (child of Tabs)",
    template: '<Tab title="${title}">\n  ${}\n</Tab>',
  },
  {
    label: "<Alert",
    detail: "tinted callout",
    template: '<Alert status="${info}">\n  ${}\n</Alert>',
  },
  {
    label: "<Image",
    detail: "inline image",
    template: '<Image src="${url}" alt="${alt}" width="${480}" />',
  },
];

const COMPONENT_OPTIONS: Completion[] = COMPONENTS.map((c) =>
  snippetCompletion(c.template, { label: c.label, type: "class", detail: c.detail }),
);

/** Query ids declared by ```sql <name> fences in the current draft. */
function draftQueryIds(doc: string): string[] {
  const ids: string[] = [];
  for (const line of doc.split(/\r\n?|\n/)) {
    const m = /^```(\w[\w-]*)[ \t]+(\S+)/.exec(line);
    if (m && m[1].toLowerCase() === "sql") ids.push(m[2]);
  }
  return [...new Set(ids)];
}

/** Fires on `<` (component tags) and `${` (query-id / params interpolation). */
export function reportCompletionSource(context: CompletionContext): CompletionResult | null {
  const tag = context.matchBefore(/<[A-Za-z]*/);
  if (tag) {
    return { from: tag.from, options: COMPONENT_OPTIONS, validFor: /^<[A-Za-z]*$/ };
  }

  const interp = context.matchBefore(/\$\{[\w.]*/);
  if (interp) {
    const ids = draftQueryIds(context.state.doc.toString());
    const options: Completion[] = [
      ...ids.map(
        (id): Completion => ({ label: id, type: "variable", detail: "query" }),
      ),
      { label: "params.", type: "keyword", detail: "runtime param", apply: "params." },
    ];
    return { from: interp.from + 2, options, validFor: /^[\w.]*$/ };
  }

  return null;
}
