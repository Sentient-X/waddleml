---
title: Capture × Training
description: The org's data supply (factory capture) beside its training outcomes — one report, two pillars.
---

Factory operational snapshots arrive through the datasets door
(`factory_orders`, `factory_pods`); training runs are the platform's own views.
Every panel below queries both sides of the pipeline in one SQL sandbox.

```sql supply
select count(*) as orders,
       sum(episodes_done) as episodes_captured,
       sum(episodes_target) as episodes_ordered
from factory_orders
```

```sql floor
select count(*) as pods,
       count(*) filter (status = 'collecting') as capturing_now
from factory_pods
```

```sql training
select count(*) as runs,
       count(*) filter (state = 'running') as training_now,
       min(try_cast(json_extract_string(summary, '$.loss') as double)) as best_loss
from runs
```

<Grid cols=3>
<BigValue data={supply} value=episodes_captured title="Episodes captured" fmt='#,##0' />
<BigValue data={floor} value=capturing_now title="Pods capturing now" />
<BigValue data={training} value=best_loss title="Best training loss" fmt='0.0000' />
</Grid>

## Orders and their capture progress

```sql orders_table
select o.id, o.customer, o.skill, o.status,
       o.episodes_done, o.episodes_target,
       round(100.0 * o.episodes_done / nullif(o.episodes_target, 0), 1) as pct_done,
       o.pod_count
from factory_orders o
order by o.created_at desc
```

<DataTable data={orders_table} search=true>
    <Column id=customer title="Customer" />
    <Column id=skill title="Skill" />
    <Column id=status title="Status" />
    <Column id=episodes_done title="Done" fmt='#,##0' align=right />
    <Column id=episodes_target title="Target" fmt='#,##0' align=right />
    <Column id=pct_done title="%" fmt='0.0' align=right />
    <Column id=pod_count title="Pods" align=right />
</DataTable>

## Supply vs training cadence

One query, both pillars: order intake beside training-run starts.

```sql cadence
select date_trunc('day', created_at) as day, 'capture orders' as kind, count(*) as n
from factory_orders group by 1, 2
union all
select date_trunc('day', started_at), 'training runs', count(*)
from runs group by 1, 2
order by 1
```

<BarChart data={cadence} x=day y=n series=kind title="Orders placed vs runs started, per day" />
