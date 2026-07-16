# Training Runs

```sql runs
select
  project,
  run_name,
  status,
  started_at,
  ended_at
from waddle.runs
order by started_at desc
```

<DataTable data={runs}/>

```sql losses
select run_name, step, value
from waddle.evidence_run_metrics
where key = 'loss'
order by run_name, step
```

<LineChart data={losses} x=step y=value series=run_name />
