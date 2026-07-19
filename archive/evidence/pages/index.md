---
title: Waddle
description: SQL-native training dashboard over WaddleML runs.
---

<Details title="About this dashboard">

Every panel below is a SQL query over a snapshot of your `waddle.duckdb`, refreshed
live by `waddle dashboard`. Use the table search to filter runs; open any run for its
full deep dive. Pages are generated from data — a new run needs no new code.

</Details>

```sql runs_table
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
order by r.started_at desc
```

```sql kpis
select count(*) as n_runs,
       count(*) filter (live_status = 'running') as n_running,
       sum(total_steps) as total_steps,
       min(latest_loss) as best_loss,
       median(avg_samples_per_second) as med_sps
from (${runs_table})
```

<BigValue data={kpis} value=n_runs title="Runs" />
<BigValue data={kpis} value=n_running title="Running now" />
<BigValue data={kpis} value=total_steps title="Total steps" fmt='#,##0' />
<BigValue data={kpis} value=best_loss title="Best latest loss" fmt='0.0000' />
<BigValue data={kpis} value=med_sps title="Median samples/s" fmt='0.00' />

## Runs

<DataTable data={runs_table} rows=15 search=true rowShading=true link=run_url>
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

## Loss across runs

```sql loss_curves
select run_name, step, value_smooth as loss
from waddle.run_metrics_ds
where key = 'loss'
order by run_name, step
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

## GPU utilization across runs

```sql gpu_util
select run_name, t, value from waddle.system_metrics
where key like '%gpu%_util_percent' order by run_name, t
```

<LineChart data={gpu_util} x=t y=value series=run_name yMax=100
    title="GPU utilization (%)" chartAreaHeight=200
    emptySet=pass emptyMessage="No GPU samples yet." />

## Throughput and hardware

<DataTable data={runs_table} rows=15 search=false>
    <Column id=run_name title="Run" wrap=true />
    <Column id=avg_samples_per_second title="Samples/s" fmt='0.00' contentType=bar barColor=#3b82f6 align=right />
    <Column id=peak_reserved_gb title="Peak reserved (GB)" fmt='0.0' contentType=bar barColor=#c2410c align=right />
    <Column id=world_size title="World size" align=right />
    <Column id=commit_sha title="Commit" />
</DataTable>

<LastRefreshed prefix="Snapshot refreshed"/>
