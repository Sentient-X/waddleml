select run_id, run_name, project, status, steps_target, last_step, last_ts,
  staleness_seconds, live_status, steps_per_second, progress, eta_seconds
from evidence_run_progress
