---
title: Waddle
description: SQL-native training dashboard over WaddleML runs.
---

<Details title="About this dashboard">

Every panel below is a SQL query over a snapshot of your `waddle.duckdb`, refreshed
live by `waddle dashboard`. Filter the runs, then open any run for its full deep dive.
Pages are generated from data — a new run needs no new code.

</Details>

```sql projects
select distinct project from waddle.runs order by project
```

```sql statuses
select distinct status from waddle.runs order by status
```

<Dropdown name=project data={projects} value=project title="Project">
    <DropdownOption value="%" valueLabel="All projects" />
</Dropdown>

<Dropdown name=status data={statuses} value=status title="Status">
    <DropdownOption value="%" valueLabel="Any status" />
</Dropdown>

<TextInput name=search title="Search run name" placeholder="filter by name…" />

```sql filtered_runs
select
    *,
    '/runs/' || run_id as run_url
from waddle.runs
where project like '${inputs.project.value}'
  and status like '${inputs.status.value}'
  and run_name ilike '%' || '${inputs.search.value}' || '%'
order by started_at desc
```

<BigValue
    data={filtered_runs}
    value=run_id
    title="Runs"
    agg=count
/>

<BigValue
    data={filtered_runs}
    value=total_steps
    title="Total steps"
    agg=sum
    fmt='#,##0'
/>

<BigValue
    data={filtered_runs}
    value=latest_loss
    title="Best latest loss"
    agg=min
    fmt='0.0000'
/>

<BigValue
    data={filtered_runs}
    value=avg_samples_per_second
    title="Median samples/s"
    agg=median
    fmt='0.00'
/>

## Runs

<DataTable data={filtered_runs} rows=15 search=false rowShading=true link=run_url>
    <Column id=run_name title="Run" wrap=true />
    <Column id=status title="Status" contentType=colorCategory colorPalette={['#4ade80','#94a3b8','#f87171']} />
    <Column id=project title="Project" />
    <Column id=total_steps title="Steps" contentType=number fmt='#,##0' align=right />
    <Column id=latest_loss title="Loss" fmt='0.0000' align=right />
    <Column id=avg_samples_per_second title="Samples/s" fmt='0.00' align=right />
    <Column id=peak_reserved_gb title="Peak GB" fmt='0.0' align=right />
    <Column id=duration_seconds title="Duration" contentType=duration durationUnits=seconds align=right />
    <Column id=node_id title="Node" />
</DataTable>

## Loss across selected runs

```sql loss_curves
select
    r.run_name,
    m.step,
    m.value as loss
from waddle.run_metrics m
inner join (${filtered_runs}) r on m.run_id = r.run_id
where m.key = 'loss'
order by r.run_name, m.step
```

<LineChart
    data={loss_curves}
    x=step
    y=loss
    series=run_name
    yLog=true
    title="Loss (log scale)"
    chartAreaHeight=280
/>

## Throughput and hardware

<DataTable data={filtered_runs} rows=15 search=false>
    <Column id=run_name title="Run" wrap=true />
    <Column id=avg_samples_per_second title="Samples/s" fmt='0.00' contentType=bar barColor=#3b82f6 align=right />
    <Column id=peak_reserved_gb title="Peak reserved (GB)" fmt='0.0' contentType=bar barColor=#c2410c align=right />
    <Column id=world_size title="World size" align=right />
    <Column id=commit_sha title="Commit" />
</DataTable>

<LastRefreshed prefix="Snapshot refreshed"/>
