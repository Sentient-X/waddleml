-- A run usually has no tags; a 0-row source produces an unreadable parquet in
-- Evidence, so emit a typed NULL sentinel when empty. Pages filter by run_id, and
-- the sentinel's NULL run_id is always excluded.
select run_id, key, value from evidence_run_tags
union all
select null::varchar, null::varchar, null::varchar
where (select count(*) from evidence_run_tags) = 0
