---
breadcrumbs:
  - label: Runs
    href: /
---

<!-- all_run_ids tells the static build which run pages exist (route discovery). -->

```sql all_run_ids
select run_id from waddle.runs
```

```sql run
select
    r.*,
    p.live_status, p.progress, p.steps_per_second, p.steps_target, p.last_step,
    p.staleness_seconds,
    case when p.eta_seconds is null then '—'
         when p.eta_seconds >= 3600 then printf('%dh %02dm', (p.eta_seconds // 3600)::int, ((p.eta_seconds % 3600) // 60)::int)
         else printf('%dm %02ds', (p.eta_seconds // 60)::int, (p.eta_seconds % 60)::int)
    end as eta_pretty,
    case when r.status != 'running' then '—'
         when p.staleness_seconds < 90 then printf('%ds ago', p.staleness_seconds::int)
         else printf('%dm ago', (p.staleness_seconds // 60)::int)
    end as last_seen,
    coalesce(r.node_id, '—') as node_disp,
    coalesce(r.commit_sha, '—') as commit_disp
from waddle.runs r
left join waddle.progress p using (run_id)
where r.run_id = '${params.run_id}'
```

# {run[0].run_name}

<span class="text-sm text-gray-500">{run[0].run_id} · {run[0].project} · node {run[0].node_disp} · commit {run[0].commit_disp}</span>

<BigValue data={run} value=live_status title="Status" />
<BigValue data={run} value=progress title="Progress" fmt='0.0%' />
<BigValue data={run} value=last_step title="Step" fmt='#,##0' />
<BigValue data={run} value=steps_per_second title="Steps/s" fmt='0.00' />
<BigValue data={run} value=eta_pretty title="ETA" />
<BigValue data={run} value=last_seen title="Last update" />
<BigValue data={run} value=latest_loss title="Latest loss" fmt='0.0000' />
<BigValue data={run} value=peak_reserved_gb title="Peak GB" fmt='0.0' />

```sql seams
select start_step, label from waddle.attempts
where run_id = '${params.run_id}' and attempt > 0
```

## Training

```sql loss
select step, value as raw, value_smooth as smoothed from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'loss' order by step
```

```sql grad
select step, value as raw, value_smooth as smoothed from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'grad_norm' order by step
```

```sql lr
select step, value as lr from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'lr' order by step
```

<Grid cols=2>
<LineChart data={loss} x=step y={['raw','smoothed']} yLog=true title="Loss (log)"
    seriesColors={{"raw": "#b7c3d4", "smoothed": "#2563eb"}} chartAreaHeight=230>
    <ReferenceLine data={seams} x=start_step label=label color=grey />
</LineChart>
<LineChart data={grad} x=step y={['raw','smoothed']} yLog=true title="Gradient norm (log)"
    seriesColors={{"raw": "#b7c3d4", "smoothed": "#2563eb"}} chartAreaHeight=230>
    <ReferenceLine data={seams} x=start_step label=label color=grey />
</LineChart>
</Grid>

<LineChart data={lr} x=step y=lr title="Learning rate" chartAreaHeight=180 />

## Performance

```sql step_seconds
select step, value as raw, value_smooth as smoothed from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'perf/step_seconds' order by step
```

```sql throughput
select step, value_smooth as samples_per_s from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'perf/samples_per_second' order by step
```

```sql data_wait
select step, value_smooth as wait_fraction from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'perf/data_wait_fraction' order by step
```

```sql vram
select step, value / 1e9 as reserved_gb from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = 'perf/peak_reserved_bytes' order by step
```

<Grid cols=2>
<LineChart data={step_seconds} x=step y={['raw','smoothed']} yLog=true title="Step time (s, log)"
    seriesColors={{"raw": "#b7c3d4", "smoothed": "#2563eb"}} chartAreaHeight=200>
    <ReferenceLine data={seams} x=start_step label=label color=grey />
</LineChart>
<LineChart data={throughput} x=step y=samples_per_s title="Samples/s" chartAreaHeight=200 />
<LineChart data={data_wait} x=step y=wait_fraction title="Dataloader wait fraction" yFmt='0.0%' chartAreaHeight=200 />
<LineChart data={vram} x=step y=reserved_gb title="Peak reserved VRAM (GB)" chartAreaHeight=200 />
</Grid>

## System

System metrics are sampled on wall-clock (not the training step); gaps are time
between attempts.

```sql sys_pct
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_percent' order by t
```

```sql sys_temp
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_temp_c' order by t
```

```sql sys_gb
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_gb' order by t
```

```sql sys_power
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_w' order by t
```

```sql sys_clock
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_mhz' order by t
```

```sql sys_io
select t, replace(key, 'system/', '') as key, value from waddle.system_metrics
where run_id = '${params.run_id}' and key like '%_mbps' order by t
```

<Grid cols=2>
<LineChart data={sys_pct} x=t y=value series=key title="Utilization (%)" chartAreaHeight=200
    emptySet=pass emptyMessage="No utilization samples." />
<LineChart data={sys_temp} x=t y=value series=key title="Temperature (°C)" chartAreaHeight=200
    emptySet=pass emptyMessage="No temperature samples." />
<LineChart data={sys_gb} x=t y=value series=key title="Memory (GB)" chartAreaHeight=200
    emptySet=pass emptyMessage="No memory samples." />
<LineChart data={sys_power} x=t y=value series=key title="Power draw (W)" chartAreaHeight=200
    emptySet=pass emptyMessage="No power samples (older waddle run)." />
<LineChart data={sys_clock} x=t y=value series=key title="SM clock (MHz)" chartAreaHeight=200
    emptySet=pass emptyMessage="No clock samples (older waddle run)." />
<LineChart data={sys_io} x=t y=value series=key title="Disk / network (MB/s)" chartAreaHeight=200
    emptySet=pass emptyMessage="No I/O samples (older waddle run)." />
</Grid>

## Any metric

```sql keys
select distinct key from waddle.run_metrics_ds
where run_id = '${params.run_id}' order by key
```

<Dropdown name=metric data={keys} value=key defaultValue="loss" title="Metric" />

```sql chosen
select step, value as raw, value_smooth as smoothed from waddle.run_metrics_ds
where run_id = '${params.run_id}' and key = '${inputs.metric.value}' order by step
```

<LineChart data={chosen} x=step y={['raw','smoothed']} title="{inputs.metric.value}"
    seriesColors={{"raw": "#b7c3d4", "smoothed": "#2563eb"}} chartAreaHeight=240>
    <ReferenceLine data={seams} x=start_step label=label color=grey />
</LineChart>

## Hyperparameters

```sql hparams
select key, value from waddle.run_params where run_id = '${params.run_id}' order by key
```

<DataTable data={hparams} rows=20 search=true>
    <Column id=key title="Parameter" />
    <Column id=value title="Value" />
</DataTable>

## Tags

```sql tags
select key, value from waddle.run_tags where run_id = '${params.run_id}' order by key
```

<DataTable data={tags} rows=10 emptySet=pass emptyMessage="No tags logged.">
    <Column id=key title="Tag" />
    <Column id=value title="Value" />
</DataTable>

## Attempts & provenance

```sql attempt_rows
select attempt, start_step, end_step,
       to_timestamp(started_ts) as started,
       (ended_ts - started_ts) / 60 as minutes
from waddle.attempts where run_id = '${params.run_id}' order by attempt
```

<DataTable data={attempt_rows} emptyMessage="No metrics yet.">
    <Column id=attempt title="Attempt" />
    <Column id=start_step title="From step" fmt='#,##0' />
    <Column id=end_step title="To step" fmt='#,##0' />
    <Column id=started title="Started" />
    <Column id=minutes title="Wall minutes" fmt='#,##0' />
</DataTable>

<DataTable data={run}>
    <Column id=commit_sha title="Commit" />
    <Column id=node_id title="Node" />
    <Column id=world_size title="World size" />
    <Column id=started_ts title="Started" />
    <Column id=ended_ts title="Ended" />
</DataTable>

<LastRefreshed prefix="Snapshot refreshed"/>
