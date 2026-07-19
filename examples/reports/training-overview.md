---
title: Training overview
description: Every run in the org — live states, best losses, loss curves.
---

The hosted port of the retired local Evidence dashboard's front page: save it with
`waddle.reports.save` (or `PUT /api/v1/reports/training-overview`) and open it in
the console's Reports tab. Every panel is a SQL query over the org's substrate
views; a new run needs no new code.

```sql runs_table
select r.name, r.run_id, r.state, r.project,
       try_cast(json_extract_string(r.summary, '$.loss') as double) as latest_loss,
       r.commit_sha, r.started_at,
       epoch(coalesce(r.finished_at, now()) - r.started_at) as duration_s
from runs r
order by r.started_at desc
```

```sql kpis
select count(*) as n_runs,
       count(*) filter (state = 'running') as n_running,
       min(latest_loss) as best_loss
from (${runs_table})
```

<BigValue data={kpis} value=n_runs title="Runs" />
<BigValue data={kpis} value=n_running title="Running now" />
<BigValue data={kpis} value=best_loss title="Best latest loss" fmt='0.0000' />

## Runs

<DataTable data={runs_table} search=true>
    <Column id=name title="Run" />
    <Column id=state title="Status" />
    <Column id=project title="Project" />
    <Column id=latest_loss title="Loss" fmt='0.0000' align=right />
    <Column id=duration_s title="Duration (s)" fmt='#,##0' align=right />
    <Column id=commit_sha title="Commit" />
</DataTable>

## Loss across runs

```sql loss_curves
-- bucket to ~200 points per run so the chart never hits the row cap
select r.name as run_name, (m.step // 25) * 25 as step, avg(m.value) as value
from metrics m join runs r using (run_id)
where m.metric_name = 'loss'
group by 1, 2
order by 1, 2
```

<LineChart data={loss_curves} x=step y=value series=run_name yLog=true
    title="Loss (log scale)" />
