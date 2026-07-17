---
title: Compare runs
description: Overlay metrics and diff hyperparameters across runs.
---

```sql all_runs
select run_id, run_name, project, status from waddle.runs order by started_at desc
```

<Dropdown name=runs data={all_runs} value=run_id label=run_name title="Runs to compare" multiple=true selectAllByDefault=true />

```sql metric_options
select distinct key from waddle.metric_keys order by key
```

<Dropdown name=metric data={metric_options} value=key defaultValue="loss" title="Metric" />

## {inputs.metric.value} across runs

```sql overlay
select r.run_name, m.step, m.value
from waddle.run_metrics m
inner join waddle.runs r on m.run_id = r.run_id
where m.key = '${inputs.metric.value}'
  and m.run_id in ${inputs.runs.value}
order by r.run_name, m.step
```

<LineChart data={overlay} x=step y=value series=run_name chartAreaHeight=320 />

## Summary

```sql summary
select run_name, status, total_steps, latest_loss, avg_samples_per_second, peak_reserved_gb, node_id
from waddle.runs
where run_id in ${inputs.runs.value}
order by latest_loss
```

<DataTable data={summary} rows=all emptyMessage="Select one or more runs above.">
    <Column id=run_name title="Run" />
    <Column id=status title="Status" />
    <Column id=total_steps title="Steps" fmt='#,##0' align=right />
    <Column id=latest_loss title="Loss" fmt='0.0000' align=right />
    <Column id=avg_samples_per_second title="Samples/s" fmt='0.00' align=right />
    <Column id=peak_reserved_gb title="Peak GB" fmt='0.0' align=right />
    <Column id=node_id title="Node" />
</DataTable>

## Hyperparameter diff

Parameters whose value differs across the selected runs.

```sql param_diff
select
    key,
    count(distinct value) as distinct_values,
    string_agg(distinct value, ' | ' order by value) as values
from waddle.run_params
where run_id in ${inputs.runs.value}
group by key
having count(distinct value) > 1
order by key
```

<DataTable data={param_diff} rows=all search=true emptyMessage="No differing parameters (or no runs selected).">
    <Column id=key title="Parameter" />
    <Column id=values title="Distinct values" wrap=true />
</DataTable>
