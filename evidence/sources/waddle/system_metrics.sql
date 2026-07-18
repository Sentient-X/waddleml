-- 0-row sources produce unreadable parquet (see run_tags.sql); a machine without
-- psutil/pynvml logs no system/* rows, so keep the NULL sentinel here too.
select project, run_name, run_id, key, t, value, value_min, value_max
from evidence_system_metrics
union all
select null, null, null, null, null::timestamp, null::double, null::double, null::double
where (select count(*) from evidence_system_metrics) = 0
