"""Reports as code — Evidence's authoring dialect, rederived for the org jail.

A report is a markdown document: YAML-ish frontmatter, named ``` ```sql name ``` ```
query fences, `${other_query}` chaining, `${params.x}` runtime parameters, and
declarative component tags (`<LineChart data={loss} x=step y=value/>`) over the
query results. The dialect and its semantics are adopted from Evidence
(github.com/evidence-dev/evidence, MIT); the implementation is original.

Two laws carried over from the source, made typed:

- **Queries form a DAG.** `${query_id}` chaining substitutes the referenced
  query as a parenthesized subquery, resolved in dependency order; a cycle or a
  reference to nothing is a typed `ReportCompileError`, never a runtime surprise.
- **Interpolation is textual, so safety comes from the jail.** Evidence splices
  `${…}` into SQL and is safe only because queries run in the author's own
  client-local DuckDB. The hosted analog is the org-jailed sqlbox: the executed
  SQL can express anything, but the sandbox physically contains only the
  caller org's data. Param values still get single-quotes doubled (hygiene,
  not the security boundary).

This module is pure — no I/O, no engine. Execution happens in the app route
via `waddle_server.sqlbox`; rendering to pixels happens in the console.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from waddle_server.errors import MissingParamsError, ReportCompileError

MAX_QUERIES_PER_REPORT = 24


class ComponentKind(StrEnum):
    """The component vocabulary (fail-closed: an unknown tag is a compile
    error). The console owns how each renders; unknown props pass through.

    Groups mirror Evidence's inventory: values (BigValue with sparkline/
    comparison, Value, Delta, Sparkline), xy + statistical + relational charts
    plus SegmentTimeline (labeled start/end spans on parallel tracks over one
    time axis — the robot-episode/annotation comparison view),
    the rich DataTable (Column contentType= bar | delta | link), **inputs**
    (Dropdown/ButtonGroup/TextInput/Slider — each binds one ``${params.name}``
    and re-renders on change), and layout (Grid, Tabs/Tab, Details, Alert,
    Image)."""

    BIG_VALUE = "BigValue"
    VALUE = "Value"
    DELTA = "Delta"
    SPARKLINE = "Sparkline"
    LINE_CHART = "LineChart"
    BAR_CHART = "BarChart"
    AREA_CHART = "AreaChart"
    SCATTER_PLOT = "ScatterPlot"
    BUBBLE_CHART = "BubbleChart"
    HISTOGRAM = "Histogram"
    HEATMAP = "Heatmap"
    FUNNEL_CHART = "FunnelChart"
    SANKEY_DIAGRAM = "SankeyDiagram"
    SEGMENT_TIMELINE = "SegmentTimeline"
    DATA_TABLE = "DataTable"
    COLUMN = "Column"
    REFERENCE_LINE = "ReferenceLine"
    DROPDOWN = "Dropdown"
    BUTTON_GROUP = "ButtonGroup"
    TEXT_INPUT = "TextInput"
    SLIDER = "Slider"
    GRID = "Grid"
    TABS = "Tabs"
    TAB = "Tab"
    DETAILS = "Details"
    ALERT = "Alert"
    IMAGE = "Image"


_XY_CHART_KINDS = frozenset(
    {
        ComponentKind.LINE_CHART,
        ComponentKind.BAR_CHART,
        ComponentKind.AREA_CHART,
        ComponentKind.SCATTER_PLOT,
        ComponentKind.BUBBLE_CHART,
    }
)
_CHART_KINDS = _XY_CHART_KINDS | frozenset(
    {
        ComponentKind.HISTOGRAM,
        ComponentKind.HEATMAP,
        ComponentKind.FUNNEL_CHART,
        ComponentKind.SANKEY_DIAGRAM,
        ComponentKind.SEGMENT_TIMELINE,
    }
)
#: input components: each binds one report param (its `name` prop); a declared
#: `defaultValue` makes that param optional at render time
INPUT_KINDS = frozenset(
    {
        ComponentKind.DROPDOWN,
        ComponentKind.BUTTON_GROUP,
        ComponentKind.TEXT_INPUT,
        ComponentKind.SLIDER,
    }
)
#: kinds that only exist as children of a specific parent
_CHILD_ONLY: dict[ComponentKind, frozenset[ComponentKind]] = {
    ComponentKind.COLUMN: frozenset({ComponentKind.DATA_TABLE}),
    ComponentKind.REFERENCE_LINE: _XY_CHART_KINDS | frozenset({ComponentKind.HISTOGRAM}),
    ComponentKind.TAB: frozenset({ComponentKind.TABS}),
}
#: kinds whose `data=` prop is mandatory
_DATA_REQUIRED = frozenset(
    {
        ComponentKind.BIG_VALUE,
        ComponentKind.VALUE,
        ComponentKind.DELTA,
        ComponentKind.SPARKLINE,
        ComponentKind.DATA_TABLE,
    }
    | _CHART_KINDS
)


@dataclass(frozen=True, slots=True)
class MarkdownBlock:
    text: str


@dataclass(frozen=True, slots=True)
class ComponentBlock:
    kind: ComponentKind
    props: Mapping[str, str]
    query: str | None
    children: tuple[Block, ...]


Block = MarkdownBlock | ComponentBlock


@dataclass(frozen=True, slots=True)
class CompiledQuery:
    id: str
    sql: str  # chaining resolved; ${params.x} left for render_sql
    params: frozenset[str]


@dataclass(frozen=True, slots=True)
class CompiledReport:
    title: str | None
    description: str | None
    queries: Mapping[str, CompiledQuery]
    blocks: tuple[Block, ...]
    #: params with no declared default — a render must supply these
    required_params: frozenset[str]
    #: input-component defaults, applied under any caller-supplied params
    param_defaults: Mapping[str, str]


class QueryRows(Protocol):
    """The slice of a sqlbox result that markdown interpolation reads."""

    @property
    def columns(self) -> Sequence[str]: ...
    @property
    def rows(self) -> Sequence[Sequence[object]]: ...


_IDENT = r"[A-Za-z_]\w*"
_FRONTMATTER_LINE = re.compile(rf"^({_IDENT}):\s*(.*)$")
_FENCE_OPEN = re.compile(r"^```([\w-]*)[ \t]*(\S*)[ \t]*$")
_FENCE_CLOSE = re.compile(r"^```\s*$")
_QUERY_NAME = re.compile(rf"^{_IDENT}$")
_SQL_REF = re.compile(r"\$\{\s*([A-Za-z_][\w.]*)\s*\}")
_PARAM_SQL = re.compile(rf"\$\{{\s*params\.({_IDENT})\s*\}}")
_TEXT_VALUE = re.compile(rf"\{{\s*({_IDENT})\[(\d+)\]\.({_IDENT})\s*\}}")
_TEXT_PARAM = re.compile(rf"\{{\s*params\.({_IDENT})\s*\}}")
_TAG_OPEN = re.compile(r"(?m)^[ \t]*<([A-Z]\w*)")
_ATTR_NAME = re.compile(rf"({_IDENT})\s*=\s*")


def compile_report(body: str) -> CompiledReport:
    """Pure and deterministic: body → CompiledReport, or a typed
    ReportCompileError (kind: bad_frontmatter | bad_query | duplicate_query |
    unknown_reference | cycle | unknown_component | bad_component)."""
    meta, rest = _split_frontmatter(body)
    queries: dict[str, str] = {}
    blocks = _parse_blocks(rest, queries)
    if len(queries) > MAX_QUERIES_PER_REPORT:
        raise ReportCompileError(
            "bad_query", f"a report holds at most {MAX_QUERIES_PER_REPORT} queries"
        )
    compiled = _compile_queries(queries)
    _validate_components(blocks, parent=None, queries=compiled)
    defaults = _input_defaults(blocks)
    required = frozenset(
        ({p for q in compiled.values() for p in q.params} | _text_params(blocks))
        - set(defaults)
    )
    return CompiledReport(
        title=meta.get("title"),
        description=meta.get("description"),
        queries=compiled,
        blocks=blocks,
        required_params=required,
        param_defaults=defaults,
    )


def render_sql(report: CompiledReport, params: Mapping[str, str]) -> dict[str, str]:
    """Resolve `${params.x}` into executable SQL for every query. Input
    defaults apply under caller-supplied values; params with neither fail
    closed. Values get single-quotes doubled (the jail, not this escaping, is
    the security boundary)."""
    effective = {**report.param_defaults, **params}
    missing = sorted(report.required_params - set(effective))
    if missing:
        raise MissingParamsError(missing)
    return {
        qid: _PARAM_SQL.sub(lambda m: effective[m.group(1)].replace("'", "''"), q.sql)
        for qid, q in report.queries.items()
    }


def effective_params(report: CompiledReport, params: Mapping[str, str]) -> dict[str, str]:
    """The param values a render actually used (defaults ⊕ supplied) — echoed
    on the wire so input controls display their live state."""
    return {**report.param_defaults, **params}


def resolve_markdown(
    text: str, results: Mapping[str, QueryRows], params: Mapping[str, str]
) -> str:
    """Substitute `{query[0].col}` and `{params.x}` value expressions into
    markdown text. An expression over missing rows/columns renders as an em
    dash — presentation, not a contract boundary (per-query errors are
    reported separately). Any other `{…}` is literal text."""

    def _value(match: re.Match[str]) -> str:
        result = results.get(match.group(1))
        if result is None:
            return "—"
        row_index = int(match.group(2))
        try:
            column_index = list(result.columns).index(match.group(3))
            value = result.rows[row_index][column_index]
        except (ValueError, IndexError):
            return "—"
        return "—" if value is None else str(value)

    text = _TEXT_VALUE.sub(_value, text)
    return _TEXT_PARAM.sub(lambda m: params.get(m.group(1), "—"), text)


# ── parsing ──────────────────────────────────────────────────────────────────


def _split_frontmatter(body: str) -> tuple[dict[str, str], str]:
    lines = body.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, body
    meta: dict[str, str] = {}
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[index + 1 :])
        matched = _FRONTMATTER_LINE.match(line)
        if matched:  # top-level scalars only; nested YAML is tolerated, ignored
            meta[matched.group(1)] = matched.group(2).strip().strip("'\"")
    raise ReportCompileError("bad_frontmatter", "frontmatter opened with --- but never closed")


def _parse_blocks(text: str, queries: dict[str, str]) -> tuple[Block, ...]:
    """Split text into markdown / query-fence / component regions. Queries are
    collected into the shared dict whatever their nesting depth."""
    blocks: list[Block] = []
    markdown: list[str] = []

    def _flush() -> None:
        chunk = "\n".join(markdown).strip("\n")
        markdown.clear()
        if chunk.strip():
            blocks.append(MarkdownBlock(chunk))

    lines = text.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        fence = _FENCE_OPEN.match(line.strip())
        if fence is not None:
            close = index + 1
            while close < len(lines) and not _FENCE_CLOSE.match(lines[close].strip()):
                close += 1
            if close >= len(lines):
                raise ReportCompileError("bad_query", "unclosed ``` fence")
            if fence.group(1) == "sql":
                _flush()
                _collect_query(fence.group(2), "\n".join(lines[index + 1 : close]), queries)
            else:  # a display code fence stays markdown, verbatim
                markdown.extend(lines[index : close + 1])
            index = close + 1
            continue
        tag = _TAG_OPEN.match(line)
        if tag is not None:
            _flush()
            block, consumed = _parse_component("\n".join(lines[index:]), queries)
            blocks.append(block)
            index += consumed
            continue
        markdown.append(line)
        index += 1
    _flush()
    return tuple(blocks)


def _collect_query(name: str, sql: str, queries: dict[str, str]) -> None:
    if not _QUERY_NAME.match(name or ""):
        raise ReportCompileError(
            "bad_query",
            "every ```sql fence needs a query name (```sql my_query); "
            "use a ```text fence for display-only SQL",
        )
    if name == "params":
        raise ReportCompileError("bad_query", "'params' is the parameter namespace, not a query name")
    if name in queries:
        raise ReportCompileError("duplicate_query", f"query {name!r} is defined twice")
    if not sql.strip():
        raise ReportCompileError("bad_query", f"query {name!r} is empty")
    queries[name] = sql.strip()


def _parse_component(text: str, queries: dict[str, str]) -> tuple[ComponentBlock, int]:
    """Parse one component tag starting on the first line of `text`. Returns
    the block and the number of lines consumed."""
    matched = _TAG_OPEN.match(text)
    assert matched is not None  # caller checked
    name = matched.group(1)
    try:
        kind = ComponentKind(name)
    except ValueError as err:
        allowed = ", ".join(sorted(k.value for k in ComponentKind))
        raise ReportCompileError(
            "unknown_component", f"<{name}> is not a report component (have: {allowed})"
        ) from err

    props: dict[str, str] = {}
    query: str | None = None
    cursor = matched.end()
    while True:
        while cursor < len(text) and text[cursor] in " \t\n":
            cursor += 1
        if text.startswith("/>", cursor):
            cursor += 2
            return (
                ComponentBlock(kind, props, query, ()),
                text.count("\n", 0, cursor) + 1,
            )
        if text.startswith(">", cursor):
            cursor += 1
            break
        attr = _ATTR_NAME.match(text, cursor)
        if attr is None:
            raise ReportCompileError(
                "bad_component", f"<{name}>: cannot parse attributes near {text[cursor:cursor+30]!r}"
            )
        cursor = attr.end()
        value, cursor = _parse_attr_value(name, text, cursor)
        if attr.group(1) == "data":
            query = value
        else:
            props[attr.group(1)] = value

    close = text.find(f"</{name}>", cursor)
    if close < 0:
        raise ReportCompileError("bad_component", f"<{name}> is never closed")
    children = _parse_blocks(text[cursor:close], queries)
    end = close + len(f"</{name}>")
    return (
        ComponentBlock(kind, props, query, children),
        text.count("\n", 0, end) + 1,
    )


def _parse_attr_value(component: str, text: str, cursor: int) -> tuple[str, int]:
    if cursor >= len(text):
        raise ReportCompileError("bad_component", f"<{component}>: attribute has no value")
    head = text[cursor]
    if head in "'\"":
        end = text.find(head, cursor + 1)
        if end < 0:
            raise ReportCompileError("bad_component", f"<{component}>: unterminated string")
        return text[cursor + 1 : end], end + 1
    if head == "{":
        depth, index = 1, cursor + 1
        while index < len(text) and depth:
            depth += {"{": 1, "}": -1}.get(text[index], 0)
            index += 1
        if depth:
            raise ReportCompileError("bad_component", f"<{component}>: unbalanced {{ in attribute")
        return text[cursor + 1 : index - 1].strip(), index
    end = cursor
    while end < len(text) and text[end] not in " \t\n>" and not text.startswith("/>", end):
        end += 1
    return text[cursor:end], end


# ── query compilation ────────────────────────────────────────────────────────


def _compile_queries(sources: Mapping[str, str]) -> dict[str, CompiledQuery]:
    """Resolve `${query}` chaining in dependency order (parenthesized-subquery
    substitution, exactly the source semantics); classify every other `${…}`
    as a param or reject it."""
    deps: dict[str, set[str]] = {}
    params: dict[str, set[str]] = {}
    for qid, sql in sources.items():
        deps[qid], params[qid] = set(), set()
        for ref in _SQL_REF.findall(sql):
            if ref in sources:
                deps[qid].add(ref)
            elif _PARAM_SQL.match("${" + ref + "}"):
                params[qid].add(ref.removeprefix("params."))
            else:
                raise ReportCompileError(
                    "unknown_reference",
                    f"query {qid!r} references ${{{ref}}} — not a query in this "
                    "report and not a params.* value",
                )

    compiled: dict[str, CompiledQuery] = {}
    visiting: set[str] = set()

    def _resolve(qid: str) -> CompiledQuery:
        if qid in compiled:
            return compiled[qid]
        if qid in visiting:
            raise ReportCompileError("cycle", f"query {qid!r} participates in a reference cycle")
        visiting.add(qid)
        sql = sources[qid]
        transitive_params = set(params[qid])
        for dep in sorted(deps[qid]):
            resolved = _resolve(dep)
            sql = re.sub(
                r"\$\{\s*" + re.escape(dep) + r"\s*\}",
                lambda _m, s=resolved.sql: "(" + s + ")",
                sql,
            )
            transitive_params |= resolved.params
        visiting.discard(qid)
        compiled[qid] = CompiledQuery(id=qid, sql=sql, params=frozenset(transitive_params))
        return compiled[qid]

    for qid in sources:
        _resolve(qid)
    return compiled


# ── validation ───────────────────────────────────────────────────────────────


def _validate_components(
    blocks: tuple[Block, ...],
    *,
    parent: ComponentKind | None,
    queries: Mapping[str, CompiledQuery],
) -> None:
    for block in blocks:
        if isinstance(block, MarkdownBlock):
            for ref, _row, _col in _TEXT_VALUE.findall(block.text):
                if ref not in queries and ref != "params":
                    raise ReportCompileError(
                        "unknown_reference", f"markdown references {{{ref}[…]}} — no such query"
                    )
            continue
        allowed_parents = _CHILD_ONLY.get(block.kind)
        if allowed_parents is not None and parent not in allowed_parents:
            raise ReportCompileError(
                "bad_component",
                f"<{block.kind.value}> only appears inside "
                f"<{'/'.join(sorted(k.value for k in allowed_parents))}>",
            )
        if block.kind in INPUT_KINDS and not _QUERY_NAME.match(block.props.get("name", "")):
            raise ReportCompileError(
                "bad_component",
                f"<{block.kind.value}> requires name=<identifier> — the "
                "${params.<name>} it binds",
            )
        if block.kind is ComponentKind.TABS and any(
            not (isinstance(child, ComponentBlock) and child.kind is ComponentKind.TAB)
            for child in block.children
        ):
            raise ReportCompileError(
                "bad_component", "<Tabs> children must all be <Tab title=…> blocks"
            )
        if block.query is not None and block.query not in queries:
            raise ReportCompileError(
                "unknown_reference",
                f"<{block.kind.value}> data={{{block.query}}} — no such query",
            )
        if block.query is None and block.kind in _DATA_REQUIRED:
            raise ReportCompileError(
                "bad_component", f"<{block.kind.value}> requires data={{some_query}}"
            )
        _validate_components(block.children, parent=block.kind, queries=queries)


def _text_params(blocks: tuple[Block, ...]) -> set[str]:
    found: set[str] = set()
    for block in blocks:
        if isinstance(block, MarkdownBlock):
            found.update(_TEXT_PARAM.findall(block.text))
        else:
            found.update(_text_params(block.children))
    return found


def _input_defaults(blocks: tuple[Block, ...]) -> dict[str, str]:
    found: dict[str, str] = {}
    for block in blocks:
        if isinstance(block, ComponentBlock):
            if block.kind in INPUT_KINDS and "defaultValue" in block.props:
                found[block.props["name"]] = block.props["defaultValue"]
            found.update(_input_defaults(block.children))
    return found
