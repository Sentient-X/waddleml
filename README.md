# WaddleML

A lightweight ML experiment tracker. Think **local Weights & Biases** — no cloud, no account, no config, no git required. Just `pip install` and start logging.

```python
import waddle

with waddle.init(project="my-project", config={"lr": 0.01, "epochs": 100}):
    for epoch in range(100):
        loss = train_one_epoch()
        waddle.log({"loss": loss, "acc": accuracy})
```

Then view everything:

```bash
waddle ls        # terminal
# and/or the hosted console (ui/, :5179) when syncing to the platform
```

## Features

- **Wandb-style API** — `waddle.init()`, `waddle.log()`, `waddle.finish()` with auto-incrementing steps, context manager, and atexit handler.
- **Works anywhere** — no git required. Use in Jupyter, Colab, Docker, or plain scripts. If you happen to be in a git repo, waddle auto-captures the commit as a bonus.
- **DuckDB storage** — fast, single-file database in `.waddle/waddle.duckdb`. No server process needed.
- **System metrics** — optional background thread captures CPU, memory, and GPU utilization.
- **SQL-native analysis views** — the `evidence_*` DuckDB views (`waddle/_schema.py`) turn a spool DB into chart-ready SQL: decimated metric streams, resume seams, live progress/ETA, per-run KPIs. Agents (the glued `waddle-dashboard` skill) and ad-hoc SQL read these, never the raw tables.
- **Hosted platform sync (optional)** — set `WADDLE_API_URL` (plus `WADDLE_API_KEY`
  outside the auth-optional dev server) and every
  run also streams to the Sentient-X waddle platform: the local DuckDB is the durable
  spool, a background thread uploads idempotent batches (at-least-once wire,
  exactly-once logical), artifacts ride presigned uploads, and a crashed or offline
  node backfills later with `waddle sync`. No env vars → purely local, exactly as before.
- **Three-command CLI** — `waddle init`, `waddle ls`, `waddle sync`.
- **Autoresearch observation** — attach a typed `ResearchTrial` to ordinary runs; the hosted
  Research view groups a long optimization session into campaign phases, then derives each
  phase's live candidates and minimize/maximize incumbent curve. The workbench lists every goal
  metric explicitly; selecting one plots its raw attempts and one direction-correct running-best
  staircase, so unlike objectives are never collapsed into an invented aggregate. A focused idea
  lineage and simple controller-authored worked/didn't-work lists make the whole
  search legible without Waddle fabricating analysis or taking ownership of the optimizer.

## The hosted platform (this repo's second half)

`waddle_server/` is the multi-tenant experiment-tracking service the SDK syncs to
(FastAPI :8400 + ClickHouse + Postgres + R2, company-isolated via the Sentient-X
identity control plane), with a compaction worker, an org-jailed DuckDB SQL endpoint,
the `waddle.*` MCP storefront, and the console UI (`ui/`, :5179). It resolves its
dependencies only inside the `glued` workspace (install with the `server` extra);
the SDK above stays dependency-light and works anywhere.

Two capabilities ride the same org-Parquet substrate the SQL sandbox jails:

- **Reports as code** (`waddle_server/reports.py` — the Evidence.dev dialect,
  rederived): an org-scoped report is a markdown doc with named ```` ```sql ````
  fences, `${other_query}` chaining, `${params.x}` parameters, and declarative
  component tags. Saved bodies are compile-validated (DAG-or-fail, typed
  errors); a render executes every query in one jailed sandbox pass and returns
  resolved blocks plus typed results. Humans read them in the console's Reports
  tab; agents author them via `waddle.reports.{list,get,save,render,preview}`.
  Examples: `examples/reports/`.
- **The datasets door** (`PUT /api/v1/datasets/{name}`): any producer publishes
  tabular snapshots into its org's substrate (typed columns + rows in, Parquet
  out); every dataset is instantly a view in `waddle.sql` and in reports. The
  factory's operational exports are the first cross-pillar producer — capture
  supply joins training outcomes in one report.
- **Research runs** (`/research`): one long optimization session contains campaign phases, and
  each phase contains a branchable candidate tree beside candidate scores and a stepped
  best-so-far curve. Evaluation trials may carry a typed `subject_run_id` edge to the candidate
  they evaluate, including across campaign phases in the same session. Agents read the same typed records through
  `waddle.runs.list(job_type="autoresearch", group_name=...)`.

## Quick Start

### 1. Install

```bash
pip install -e .
```

### 2. Instrument your training script

```python
import waddle

with waddle.init(
    project="cifar10",
    name="resnet-baseline",
    config={"lr": 0.001, "batch_size": 64, "epochs": 50},
    tags={"model": "resnet18"},
):
    for epoch in range(50):
        loss, acc = train_epoch()
        waddle.log({"loss": loss, "acc": acc})

    waddle.log_artifact("model.pt", "checkpoints/best.pt", kind="model")
```

### 3. View results

```bash
waddle ls              # quick look in the terminal
```

For visual analysis, sync to the hosted platform and use the console (`ui/`, :5179),
or — inside the glued workspace — ask an agent, which uses the `waddle-dashboard`
skill to mine the DuckDB with SQL and publish an insight-first report.

## Python API

### `waddle.init(...) -> Run`

Start a new run. If inside a git repo, auto-captures the commit. If not, works fine without it.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | `str` | `"default"` | Project name (groups runs) |
| `name` | `str` | `None` | Human-readable run name |
| `config` | `dict` | `None` | Hyperparameters — auto-logged as params |
| `tags` | `dict` | `None` | Categorical labels |
| `system_metrics` | `bool` | `True` | Collect CPU/mem/GPU in background |
| `db_path` | `str` | `None` | Override DuckDB path |
| `research` | `ResearchTrial` | `None` | Make this run one typed candidate in an external optimization campaign |

Returns a `Run` that works as a context manager.

### Observe an external autoresearch loop

The controller still proposes, evaluates, and keeps or rejects candidates. Waddle only records
each evaluated candidate as a normal run:

```python
import waddle
from waddle import ResearchDecision, ResearchGoal, ResearchOutcome, ResearchTrial

run = waddle.init(
    project="edge-inference",
    name="static-buffers",
    research=ResearchTrial(
        session_name="edge-inference-overnight",
        campaign="pi05-rtx5090-b1",
        trial_index=7,
        objective_name="latency/p99_ms",
        goal=ResearchGoal.MINIMIZE,
        hypothesis="static buffers remove allocation overhead",
        rationale="the trace attributes repeated time to allocation and launch overhead",
        expected_outcome="p99 improves by at least 2% with identical actions",
        falsification_criteria="any correctness gate fails or p99 improves by less than 2%",
        parent_run_id="4f3c9e4d4c864d73bf86917e9bc11ba0",
    ),
)
result = run_frozen_evaluator()
waddle.log(result.metrics, step=7)
run.finish(
    research_outcome=ResearchOutcome(
        decision=ResearchDecision.KEEP,
        evidence="p99 improved 3.1%; every registered correctness gate passed",
        conclusion="static buffers removed material launch-path overhead",
        next_step="confirm in three clean processes",
    )
)
```

The session name joins related campaign phases into one top-level Research run. A phase is derived
from campaign name, objective, and direction; changing objective or direction starts a distinct
phase even when a historical controller reuses the campaign name. Session membership is immutable
within that campaign family. A phase root may have no parent or may point back to the candidate
that motivated the phase. Legacy research records without `session_name` are grouped by project,
so an existing overnight history becomes one run without rewriting evidence. Remote outages do
not interrupt the loop because the local DuckDB remains the durable spool.

Proposal context and terminal outcomes are controller-authored facts. Waddle does not generate
explanations: `ResearchTrial` carries the rationale, expected outcome, and falsification criteria;
`ResearchOutcome` carries the decision, evidence, conclusion, failed gates, and next step. Legacy,
running, or interrupted trials may lack those additive fields. The console labels the omission and
uses only terminal state plus objective order for its explicitly marked legacy selection line.

An evaluator uses `subject_run_id` to identify the run whose artifact or policy it measures. This
edge may cross campaign phases inside the same research session. `parent_run_id` is the search-tree
edge and may also cross a phase boundary when one experiment leads to a new objective. The hosted
API rejects missing targets, self-links, and cross-project or cross-session links.

### `waddle.log(metrics, step=None)`

Log a dictionary of metrics. Step auto-increments if omitted.

```python
waddle.log({"loss": 0.5, "acc": 0.9})        # step 0
waddle.log({"loss": 0.3, "acc": 0.95})       # step 1
waddle.log({"loss": 0.1}, step=100)           # explicit step
```

### `waddle.log_param(key, value)` / `waddle.log_tag(key, value)`

Log individual parameters or tags after init.

### `waddle.log_artifact(name, path=None, kind="file", inline=False)`

Log an output file. If `path` is given, records its location (and optionally stores its contents in DuckDB when `inline=True`).

### `waddle.finish()`

End the active run. Called automatically with `with waddle.init(...)` or at process exit.

## CLI

```
waddle init [--path PATH]                          # create .waddle/ and .gitignore entry
waddle ls [-n 20] [--db PATH]                      # list recent runs in terminal
waddle sync [--db PATH] [--run RUN_ID]             # backfill a spool DB to the hosted platform
```

### `waddle ls`

```
$ waddle ls
      ID  Project          Name                  Status     Duration   Commit
-------------------------------------------------------------------------------------
a1b2c3d4  hp-sweep         lr=0.1                completed       0.2s  f3e2d1a0
e5f6a7b8  hp-sweep         lr=0.05               completed       0.2s  f3e2d1a0
c9d0e1f2  quickstart       c9d0e1f2              completed       0.1s
```

Runs without git show no commit — that's fine.

## Examples

Four examples, from minimal to full-featured:

### 1. Quickstart — minimal

```bash
python examples/quickstart.py
```

20 lines. Shows `init`, `log`, `log_param`, `log_tag`.

### 2. Linear Regression — full instrumentation

```bash
python examples/linear_regression.py --epochs 100 --lr 0.03
```

Per-epoch metrics, evaluation, model artifact.

### 3. Hyperparameter Sweep — compare runs

```bash
python examples/hyperparameter_sweep.py
waddle ls  # then compare in the console or via the waddle-dashboard skill
```

4 runs with different learning rates. Compare overlaid loss curves and parameter diffs.

### 4. Classification — different model type

```bash
python examples/classification.py --epochs 200
```

Binary classification with a perceptron. Loss, accuracy, learned parameters.

## Analysis over the spool

Every spool DB carries the `evidence_*` views (`waddle/_schema.py`) — the SQL read
contract for analysis: decimated chart-ready metric streams (`evidence_run_metrics_ds`),
resume seams (`evidence_attempts`), live progress/ETA/staleness
(`evidence_run_progress`), per-run KPIs (`evidence_runs`), params/tags unwrapped.
Snapshot the DB (copy it plus its `.wal` — never open the live file) and query the
views from DuckDB. In the glued workspace, the `waddle-dashboard` agent skill does
exactly this and publishes an insight-first HTML report.

The Evidence.dev local dashboard that these views were originally built for was
retired and deleted 2026-07-19 (git history has it); the hosted console (`ui/`) is
the passive always-on dashboard.

## Git Integration (Optional)

When you run `waddle.init()` inside a git repository:
- Captures the commit SHA and links it to the run
- Hashes a dirty working-tree patch into lineage without changing or committing user files
- Records commit metadata (author, message, tree)
- Surfaces commit info in `waddle ls`, the views, and the console

When not in a git repo, everything works the same — you just don't get commit tracking.

## System Metrics

When `system_metrics=True` (default), a background thread samples every 5s:

| Metric | Source |
|--------|--------|
| `system/cpu_percent` | psutil |
| `system/memory_percent` | psutil |
| `system/memory_used_gb` | psutil |
| `system/gpu0_util_percent` | pynvml |
| `system/gpu0_memory_used_gb` | pynvml |
| `system/gpu0_temp_c` | pynvml |

Missing deps are silently skipped.

## Dependencies

**Required (Python):** `duckdb`

**Optional (Python):** `psutil` (CPU/mem), `pynvml` (GPU)

The Python package has no web deps.

```bash
pip install -e ".[all]"    # everything (Python side)
```

## Project Structure

```
waddle/
    __init__.py          # Public API: init, log, finish, ...
    _api.py              # Module-level functions
    _run.py              # Run class
    _state.py            # Global run state
    _db.py               # WaddleDB (DuckDB)
    _schema.py           # DDL + evidence_* analysis views
    _git.py              # Git detection (optional)
    _sysmetrics.py       # System monitor thread
    _types.py            # WorkerInfo and typed autoresearch records
    cli.py               # CLI: init, ls, sync
```

## License

MIT
