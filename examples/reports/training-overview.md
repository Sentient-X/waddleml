---
title: Training overview
description: The org's training activity — filterable, comparative, live.
---

```sql projects
select distinct project from runs order by 1
```

<Dropdown name=project data={projects} value=project defaultValue=libero-bc title="Project" />

```sql loss_trend
select (m.step // 25) * 25 as step, avg(m.value) as loss
from metrics m join runs r using (run_id)
where m.metric_name = 'loss' and r.project = '${params.project}'
group by 1 order by 1
```

```sql loss_kpi
select step, loss,
       last_value(loss) over w as now_loss,
       last_value(loss) over w - first_value(loss) over w as change
from (${loss_trend})
window w as (order by step rows between unbounded preceding and unbounded following)
order by step
```

```sql eval_kpi
select coalesce(arg_max(m.value, m.step), 0) as success_rate
from metrics m join runs r using (run_id)
where m.metric_name = 'eval/success_rate' and r.project = '${params.project}'
```

```sql runs_table
select r.name, r.run_id, r.state,
       try_cast(json_extract_string(r.summary, '$.loss') as double) as latest_loss,
       try_cast(json_extract_string(r.summary, '$.loss') as double)
           - min(try_cast(json_extract_string(r.summary, '$.loss') as double)) over () as vs_best,
       try_cast(json_extract_string(r.config, '$.lr') as double) as lr,
       epoch(coalesce(r.finished_at, now()) - r.started_at) as duration_s
from runs r
where r.project = '${params.project}'
order by latest_loss
```

<Grid cols=3>
<BigValue data={runs_table} value=name title="Best run" />
<BigValue data={loss_kpi} value=now_loss title="Loss (project-wide)" fmt='0.0000'
    sparkline=loss comparison=change comparisonTitle="since start" comparisonFmt='0.0000'
    downIsGood=true />
<BigValue data={eval_kpi} value=success_rate title="Eval success rate" fmt='0.0%' />
</Grid>

## Runs

Sorted best-first; `vs best` is each run's distance from the project's best latest loss.

<DataTable data={runs_table} search=true>
    <Column id=name title="Run" />
    <Column id=state title="Status" />
    <Column id=latest_loss title="Loss" fmt='0.0000' align=right />
    <Column id=vs_best title="vs best" contentType=delta fmt='0.0000' downIsGood=true align=right />
    <Column id=lr title="LR" align=right />
    <Column id=duration_s title="Duration (s)" contentType=bar fmt='#,##0' align=right />
</DataTable>

## Schedule

Each lane is a run; the span is its wall-clock life, colored by how it ended.

```sql run_spans
select r.name as run, r.started_at as t0,
       coalesce(r.finished_at, now()) as t1, r.state
from runs r
where r.project = '${params.project}' and r.started_at is not null
order by r.started_at
```

<SegmentTimeline data={run_spans} track=run start=t0 end=t1 label=state
    title="Run wall-clock schedule" />

## Curves

```sql loss_curves
select r.name as run_name, (m.step // 25) * 25 as step, avg(m.value) as value
from metrics m join runs r using (run_id)
where m.metric_name = 'loss' and r.project = '${params.project}'
group by 1, 2 order by 1, 2
```

```sql lr_curves
select r.name as run_name, (m.step // 25) * 25 as step, avg(m.value) as value
from metrics m join runs r using (run_id)
where m.metric_name = 'lr' and r.project = '${params.project}'
group by 1, 2 order by 1, 2
```

```sql grad_values
select m.value from metrics m join runs r using (run_id)
where m.metric_name = 'grad_norm' and r.project = '${params.project}'
using sample reservoir(900 rows) repeatable (42)
```

```sql system_util
select m.step as sample, avg(m.value) as cpu_percent
from metrics m join runs r using (run_id)
where m.metric_name = 'system/cpu_percent' and r.project = '${params.project}'
group by 1 order by 1
```

<Tabs>
<Tab title="Loss">
<LineChart data={loss_curves} x=step y=value series=run_name yLog=true
    title="Loss (log scale)" />
</Tab>
<Tab title="Learning rate">
<LineChart data={lr_curves} x=step y=value series=run_name title="LR schedule" />
</Tab>
<Tab title="Gradient norms">
<Histogram data={grad_values} x=value bins=30 title="Gradient-norm distribution" />
</Tab>
<Tab title="System">
<AreaChart data={system_util} x=sample y=cpu_percent yMax=100 title="CPU utilization (%)" />
</Tab>
</Tabs>

## The sweep, at a glance

Each point is a run: its learning rate against where its loss landed.

```sql sweep
select r.name, try_cast(json_extract_string(r.config, '$.lr') as double) as lr,
       try_cast(json_extract_string(r.summary, '$.loss') as double) as latest_loss
from runs r
where r.project = '${params.project}'
  and json_extract_string(r.config, '$.lr') is not null
```

<ScatterPlot data={sweep} x=lr y=latest_loss series=name title="LR vs final loss" />
