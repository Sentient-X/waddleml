---
breadcrumbs:
  - label: Runs
    href: /
---

```sql all_run_ids
select run_id from waddle.runs
```

```sql run
select * from waddle.runs where run_id = '${params.run_id}'
```

# {run.run_name}

<span class="text-sm text-gray-500">{run.run_id} · {run.project} · node {run.node_id}</span>

<BigValue data={run} value=status title="Status" />
<BigValue data={run} value=total_steps title="Steps" fmt='#,##0' />
<BigValue data={run} value=latest_loss title="Latest loss" fmt='0.0000' />
<BigValue data={run} value=latest_grad_norm title="Grad norm" fmt='0.000' />
<BigValue data={run} value=avg_samples_per_second title="Samples/s" fmt='0.00' />
<BigValue data={run} value=peak_reserved_gb title="Peak GB" fmt='0.0' />
<BigValue data={run} value=duration_seconds title="Duration" fmt='#,##0' />

## Training curves

```sql loss
select step, value as loss from waddle.run_metrics
where run_id = '${params.run_id}' and key = 'loss' order by step
```

```sql lr
select step, value as lr from waddle.run_metrics
where run_id = '${params.run_id}' and key = 'lr' order by step
```

```sql grad
select step, value as grad_norm from waddle.run_metrics
where run_id = '${params.run_id}' and key = 'grad_norm' order by step
```

<Grid cols=2>
<LineChart data={loss} x=step y=loss yLog=true title="Loss (log)" chartAreaHeight=220 />
<LineChart data={lr} x=step y=lr title="Learning rate" chartAreaHeight=220 />
</Grid>

<LineChart data={grad} x=step y=grad_norm title="Gradient norm" chartAreaHeight=200 />

## Any metric

```sql keys
select distinct key from waddle.metric_keys
where run_id = '${params.run_id}' order by key
```

<Dropdown name=metric data={keys} value=key defaultValue="loss" title="Metric" />

```sql chosen
select step, value from waddle.run_metrics
where run_id = '${params.run_id}' and key = '${inputs.metric.value}' order by step
```

<LineChart data={chosen} x=step y=value title="{inputs.metric.value}" chartAreaHeight=240 />

## Throughput and system

```sql perf
select step, key, value from waddle.run_metrics
where run_id = '${params.run_id}' and key in ('perf/samples_per_second','perf/step_seconds','perf/data_wait_fraction')
order by step
```

<LineChart data={perf} x=step y=value series=key title="Performance" chartAreaHeight=220 />

```sql system
select step, key, value from waddle.run_metrics
where run_id = '${params.run_id}'
  and key in ('system/gpu0_util_percent','system/gpu0_memory_used_gb','system/gpu0_temp_c','system/cpu_percent','system/memory_percent')
order by step
```

<LineChart data={system} x=step y=value series=key title="GPU / CPU / memory" chartAreaHeight=240 />

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

<DataTable data={tags} rows=10 emptyMessage="No tags logged.">
    <Column id=key title="Tag" />
    <Column id=value title="Value" />
</DataTable>

## Provenance

<DataTable data={run}>
    <Column id=commit_sha title="Commit" />
    <Column id=node_id title="Node" />
    <Column id=world_size title="World size" />
    <Column id=started_ts title="Started" />
    <Column id=ended_ts title="Ended" />
</DataTable>
