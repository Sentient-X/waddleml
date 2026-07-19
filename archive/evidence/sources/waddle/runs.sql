select
  project, run_id, run_name, status,
  started_at, ended_at, commit_sha, duration_seconds,
  total_steps, latest_loss, latest_lr, latest_grad_norm,
  avg_samples_per_second, peak_reserved_gb, node_id, world_size,
  to_timestamp(started_at) as started_ts,
  to_timestamp(ended_at) as ended_ts
from evidence_runs
