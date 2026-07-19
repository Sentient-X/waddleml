"""The report compiler: Evidence's semantics (chaining as parenthesized-
subquery substitution, DAG-or-fail, runtime params) pinned as typed laws."""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from waddle_server.errors import MissingParamsError, ReportCompileError  # noqa: E402
from waddle_server.reports import (  # noqa: E402
    ComponentBlock,
    ComponentKind,
    MarkdownBlock,
    compile_report,
    render_sql,
    resolve_markdown,
)

OVERVIEW = """---
title: Training overview
description: Runs at a glance.
---

Some intro prose.

```sql runs_table
select run_id, name, state from runs order by created_at desc
```

```sql kpis
select count(*) as n_runs from (${runs_table})
```

<BigValue data={kpis} value=n_runs title="Runs" />

## Loss

```sql loss
select step, value from metrics where metric_name = 'loss'
  and run_id = '${params.run_id}'
```

<LineChart data={loss} x=step y=value yLog=true title="Loss (log)" />

<DataTable data={runs_table} search=true>
    <Column id=name title="Run" />
    <Column id=state title="Status" />
</DataTable>
"""


def test_compiles_the_full_dialect() -> None:
    report = compile_report(OVERVIEW)
    assert report.title == "Training overview"
    assert report.description == "Runs at a glance."
    assert sorted(report.queries) == ["kpis", "loss", "runs_table"]
    assert report.required_params == frozenset({"run_id"})

    # Chaining is parenthesized-subquery substitution (the source semantics).
    kpis = report.queries["kpis"].sql
    assert "(select run_id, name, state from runs order by created_at desc)" in kpis
    assert "${" not in kpis
    # Params stay for render time; only loss (and nothing else) requires one.
    assert report.queries["loss"].params == frozenset({"run_id"})
    assert report.queries["kpis"].params == frozenset()

    kinds = [b.kind for b in report.blocks if isinstance(b, ComponentBlock)]
    assert kinds == [ComponentKind.BIG_VALUE, ComponentKind.LINE_CHART, ComponentKind.DATA_TABLE]
    table = report.blocks[-1]
    assert isinstance(table, ComponentBlock)
    assert [c.kind for c in table.children if isinstance(c, ComponentBlock)] == [
        ComponentKind.COLUMN,
        ComponentKind.COLUMN,
    ]
    assert table.props["search"] == "true"


def test_transitive_chaining_and_param_propagation() -> None:
    report = compile_report(
        "```sql a\nselect 1 as x where '${params.p}' = 'v'\n```\n"
        "```sql b\nselect * from (${a})\n```\n"
        "```sql c\nselect * from (${b})\n```\n"
    )
    assert "select 1 as x" in report.queries["c"].sql
    # A query inherits the params of everything it inlines.
    assert report.queries["c"].params == frozenset({"p"})


def test_cycle_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql a\nselect * from (${b})\n```\n```sql b\nselect * from (${a})\n```\n")
    assert err.value.kind == "cycle"


def test_unknown_reference_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql a\nselect * from ${nowhere}\n```\n")
    assert err.value.kind == "unknown_reference"


def test_unnamed_sql_fence_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql\nselect 1\n```\n")
    assert err.value.kind == "bad_query"


def test_duplicate_query_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql a\nselect 1\n```\n```sql a\nselect 2\n```\n")
    assert err.value.kind == "duplicate_query"


def test_unknown_component_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("<VennDiagram data={q} />\n```sql q\nselect 1\n```\n")
    assert err.value.kind == "unknown_component"


def test_inputs_bind_params_with_defaults() -> None:
    report = compile_report(
        "```sql projects\nselect distinct project from runs\n```\n"
        "<Dropdown name=project data={projects} value=project defaultValue=libero-bc />\n"
        "<Slider name=window min=10 max=500 defaultValue=100 />\n"
        "```sql filtered\nselect * from runs where project = '${params.project}'"
        " limit ${params.window}\n```\n"
        "```sql by_user\nselect * from runs where name = '${params.who}'\n```\n"
    )
    # Defaulted params are optional; undefaulted ones stay required.
    assert report.param_defaults == {"project": "libero-bc", "window": "100"}
    assert report.required_params == frozenset({"who"})
    rendered = render_sql(report, {"who": "x", "window": "25"})
    assert "limit 25" in rendered["filtered"]  # supplied beats default
    assert "project = 'libero-bc'" in rendered["filtered"]  # default applied


def test_input_requires_a_param_name() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("<Dropdown data={q} />\n```sql q\nselect 1 as v\n```\n")
    assert err.value.kind == "bad_component"


def test_tabs_only_hold_tabs() -> None:
    ok = compile_report(
        "```sql q\nselect 1 as v\n```\n"
        '<Tabs>\n<Tab title="One">\n<Value data={q} column=v />\n</Tab>\n</Tabs>\n'
    )
    assert isinstance(ok.blocks[0], ComponentBlock)
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql q\nselect 1 as v\n```\n<Tabs>\n<Value data={q} column=v />\n</Tabs>\n")
    assert err.value.kind == "bad_component"
    with pytest.raises(ReportCompileError) as err:
        compile_report('<Tab title="loose">\ntext\n</Tab>\n')
    assert err.value.kind == "bad_component"


def test_segment_timeline_is_a_data_component() -> None:
    report = compile_report(
        "```sql spans\nselect 'gold' as track, 0.0 as t0, 1.5 as t1, 'grasp' as label\n```\n"
        "<SegmentTimeline data={spans} track=track start=t0 end=t1 label=label />\n"
    )
    block = report.blocks[-1]
    assert isinstance(block, ComponentBlock)
    assert block.kind == ComponentKind.SEGMENT_TIMELINE
    assert block.query == "spans"
    with pytest.raises(ReportCompileError) as err:
        compile_report("<SegmentTimeline track=t start=a end=b label=l />\n")
    assert err.value.kind == "bad_component"  # charts require data={...}


def test_component_without_its_query_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("<BigValue data={ghost} value=x />")
    assert err.value.kind == "unknown_reference"


def test_column_outside_datatable_fails_closed() -> None:
    with pytest.raises(ReportCompileError) as err:
        compile_report("```sql q\nselect 1\n```\n<Column id=x />")
    assert err.value.kind == "bad_component"


def test_display_fences_and_html_stay_markdown() -> None:
    report = compile_report(
        "```text\nselect looks_like_sql\n```\n\n<span class=x>inline html</span>\n"
    )
    assert report.queries == {}
    assert len(report.blocks) == 1 and isinstance(report.blocks[0], MarkdownBlock)
    assert "select looks_like_sql" in report.blocks[0].text
    assert "<span" in report.blocks[0].text


def test_render_sql_splices_and_escapes_params() -> None:
    report = compile_report(
        "```sql q\nselect * from runs where name = '${params.who}'\n```\n"
    )
    rendered = render_sql(report, {"who": "o'brien"})
    assert rendered["q"] == "select * from runs where name = 'o''brien'"
    with pytest.raises(MissingParamsError) as err:
        render_sql(report, {})
    assert err.value.missing == ["who"]


class _Rows:
    def __init__(self, columns: list[str], rows: list[list[object]]) -> None:
        self.columns = columns
        self.rows = rows


def test_markdown_value_interpolation() -> None:
    text = "Best: {kpis[0].best_loss} for {params.who}; missing {kpis[9].best_loss}; not {an expr}"
    resolved = resolve_markdown(
        text, {"kpis": _Rows(["best_loss"], [[0.125]])}, {"who": "piper"}
    )
    assert resolved == "Best: 0.125 for piper; missing —; not {an expr}"


def test_markdown_params_count_as_required() -> None:
    report = compile_report("# Run {params.run_id}\n```sql q\nselect 1\n```\n")
    assert report.required_params == frozenset({"run_id"})
