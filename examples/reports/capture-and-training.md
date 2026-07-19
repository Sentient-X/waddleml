---
title: Capture × Training
description: The data supply chain — factory floor to training runs, one report.
---

```sql supply
select sum(episodes_target) as ordered,
       sum(episodes_done) as captured,
       sum(episodes_done) filter (status in ('qa', 'delivering', 'complete')) as delivered
from factory_orders
```

```sql at_risk
select count(*) as n, string_agg(customer, ', ') as who
from factory_orders
where sla_due_at < now() + interval 3 day
  and episodes_done < 0.6 * episodes_target
  and status not in ('complete', 'cancelled')
```

<Grid cols=3>
<BigValue data={supply} value=ordered title="Episodes ordered" fmt='#,##0' />
<BigValue data={supply} value=captured title="Episodes captured" fmt='#,##0' />
<BigValue data={at_risk} value=n title="Orders at SLA risk" />
</Grid>

<Alert status=warning>
**{at_risk[0].n} orders are at SLA risk** (due within 3 days, under 60% captured): {at_risk[0].who}.
</Alert>

## Where the episodes flow

Customer demand routed through skills — the width is captured episodes.

```sql flow
select customer as source, skill as target, episodes_done as value
from factory_orders
where episodes_done > 0
```

<SankeyDiagram data={flow} source=source target=target value=value title="Captured episodes by customer → skill" />

## The pipeline

```sql funnel
select 'Ordered' as stage, sum(episodes_target) as episodes from factory_orders
union all
select 'Captured', sum(episodes_done) from factory_orders
union all
select 'QA / delivered', coalesce(sum(episodes_done)
    filter (status in ('qa', 'delivering', 'complete')), 0) from factory_orders
order by episodes desc
```

<FunnelChart data={funnel} label=stage value=episodes title="Episode pipeline" />

## Orders

```sql orders_table
select o.customer, o.skill, o.status,
       o.episodes_done, o.episodes_target,
       round(100.0 * o.episodes_done / nullif(o.episodes_target, 0), 1) as pct_done,
       o.pod_count, o.sla_due_at
from factory_orders o
order by pct_done
```

<DataTable data={orders_table} search=true>
    <Column id=customer title="Customer" />
    <Column id=skill title="Skill" />
    <Column id=status title="Status" />
    <Column id=pct_done title="Progress" contentType=bar fmt='0.0' align=right />
    <Column id=episodes_done title="Done" fmt='#,##0' align=right />
    <Column id=episodes_target title="Target" fmt='#,##0' align=right />
    <Column id=pod_count title="Pods" align=right />
</DataTable>

## The floor

<ButtonGroup name=pool options="customer,general" defaultValue=customer title="Pod pool" />

```sql floor_heat
select p.pool, p.rig_type, avg(p.episodes_total) as avg_episodes
from factory_pods p
group by 1, 2
```

```sql pods_table
select p.name, p.rig_type, p.status, p.episodes_today, p.episodes_total, p.current_order_id
from factory_pods p
where p.pool = '${params.pool}'
order by p.episodes_total desc
```

<Grid cols=2>
<Heatmap data={floor_heat} x=pool y=rig_type value=avg_episodes title="Avg episodes by rig × pool" />
<DataTable data={pods_table}>
    <Column id=name title="Pod" />
    <Column id=rig_type title="Rig" />
    <Column id=status title="Status" />
    <Column id=episodes_today title="Today" contentType=bar align=right />
</DataTable>
</Grid>

## Beside the training side

Capture supply and training outcomes share one SQL sandbox — the join the
platform exists for.

```sql cadence
select date_trunc('day', created_at) as day, 'capture orders' as kind, count(*) as n
from factory_orders group by 1, 2
union all
select date_trunc('day', started_at), 'training runs', count(*)
from runs group by 1, 2
order by 1
```

<BarChart data={cadence} x=day y=n series=kind title="Orders placed vs runs started, per day" />
