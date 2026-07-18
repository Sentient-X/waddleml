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
select distinct live_status as status from waddle.progress order by 1
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
    r.*,
    p.live_status, p.progress, p.last_step, p.steps_per_second, p.staleness_seconds,
    case when p.eta_seconds is null then ''
         when p.eta_seconds >= 3600 then printf('%dh %02dm', (p.eta_seconds // 3600)::int, ((p.eta_seconds % 3600) // 60)::int)
         else printf('%dm', (p.eta_seconds // 60)::int)
    end as eta_pretty,
    '/runs/' || r.run_id as run_url
from waddle.runs r
left join waddle.progress p using (run_id)
where r.project like '${inputs.project.value}'
  and p.live_status like '${inputs.status.value}'
  and r.run_name ilike '%' || '${inputs.search.value}' || '%'
order by r.started_at desc
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

<!-- DataTable row links are client-side; these hidden anchors make /runs/[run_id]
     pages discoverable by the static build's crawler. -->
{#each filtered_runs as r}
<a href="{r.run_url}" style="display:none" aria-hidden="true">{r.run_name}</a>
{/each}

<DataTable data={filtered_runs} rows=15 search=false rowShading=true link=run_url>
    <Column id=run_name title="Run" wrap=true />
    <Column id=live_status title="Status" contentType=colorCategory colorPalette={['#4ade80','#f8c900','#94a3b8','#f87171']} />
    <Column id=progress title="Progress" contentType=bar barColor=#2563eb fmt='0%' align=right />
    <Column id=last_step title="Step" contentType=number fmt='#,##0' align=right />
    <Column id=steps_per_second title="Steps/s" fmt='0.00' align=right />
    <Column id=eta_pretty title="ETA" align=right />
    <Column id=latest_loss title="Loss" fmt='0.0000' align=right />
    <Column id=peak_reserved_gb title="Peak GB" fmt='0.0' align=right />
    <Column id=duration_seconds title="Duration" contentType=duration durationUnits=seconds align=right />
    <Column id=node_id title="Node" />
</DataTable>

## Loss across selected runs

```sql loss_curves
select
    m.run_name,
    m.step,
    m.value_smooth as loss
from waddle.run_metrics_ds m
inner join (${filtered_runs}) r on m.run_id = r.run_id
where m.key = 'loss'
order by m.run_name, m.step
```

<LineChart
    data={loss_curves}
    x=step
    y=loss
    series=run_name
    yLog=true
    title="Loss (smoothed, log scale)"
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
