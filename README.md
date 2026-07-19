# WaddleML

A lightweight ML experiment tracker with a local dashboard. Think **local Weights & Biases** — no cloud, no account, no config, no git required. Just `pip install` and start logging.

```python
import waddle

with waddle.init(project="my-project", config={"lr": 0.01, "epochs": 100}):
    for epoch in range(100):
        loss = train_one_epoch()
        waddle.log({"loss": loss, "acc": accuracy})
```

Then view everything:

```bash
waddle dashboard
# open http://localhost:3000
```

## Features

- **Wandb-style API** — `waddle.init()`, `waddle.log()`, `waddle.finish()` with auto-incrementing steps, context manager, and atexit handler.
- **Works anywhere** — no git required. Use in Jupyter, Colab, Docker, or plain scripts. If you happen to be in a git repo, waddle auto-captures the commit as a bonus.
- **DuckDB storage** — fast, single-file database in `.waddle/waddle.duckdb`. No server process needed.
- **System metrics** — optional background thread captures CPU, memory, and GPU utilization.
- **SQL-native dashboard** — an [Evidence.dev](https://evidence.dev) project (`evidence/`) reading the `evidence_*` DuckDB views: a filterable runs overview, a per-run deep-dive generated for every run, and multi-run comparison. `waddle dashboard` snapshots the DB and serves it live.
- **Hosted platform sync (optional)** — set `WADDLE_API_URL` (plus `WADDLE_API_KEY`
  outside the auth-optional dev server) and every
  run also streams to the Sentient-X waddle platform: the local DuckDB is the durable
  spool, a background thread uploads idempotent batches (at-least-once wire,
  exactly-once logical), artifacts ride presigned uploads, and a crashed or offline
  node backfills later with `waddle sync`. No env vars → purely local, exactly as before.
- **Four-command CLI** — `waddle init`, `waddle ls`, `waddle dashboard`, `waddle sync`.

## The hosted platform (this repo's second half)

`waddle_server/` is the multi-tenant experiment-tracking service the SDK syncs to
(FastAPI :8400 + ClickHouse + Postgres + R2, company-isolated via the Sentient-X
identity control plane), with a compaction worker, an org-jailed DuckDB SQL endpoint,
the `waddle.*` MCP storefront, and the console UI (`ui/`, :5179). It resolves its
dependencies only inside the `glued` workspace (install with the `server` extra);
the SDK above stays dependency-light and works anywhere.

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
waddle dashboard       # full dashboard at http://localhost:3000
```

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

Returns a `Run` that works as a context manager.

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
waddle dashboard [--db PATH] [--port PORT]         # launch the Evidence dashboard
                [--refresh SECONDS] [--no-install]
```

`waddle dashboard` finds the nearest `.waddle/waddle.duckdb` (or takes `--db`),
copies a snapshot into the Evidence project, launches `evidence dev`, and re-copies
the snapshot every `--refresh` seconds (default 10) so the dashboard tracks a running
job. First launch runs `npm install` in `evidence/` (Node ≥18 required); pass
`--no-install` to skip. Point `--db` at a project-wide `.waddle/waddle.duckdb` to see
many runs at once, or at a single run's DB (e.g. `.runs/<run>/waddle.duckdb`).

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
waddle dashboard  # open /compare, select runs
```

4 runs with different learning rates. Compare overlaid loss curves and parameter diffs.

### 4. Classification — different model type

```bash
python examples/classification.py --epochs 200
```

Binary classification with a perceptron. Loss, accuracy, learned parameters.

## Dashboard

The dashboard is an [Evidence.dev](https://evidence.dev) project in `evidence/` —
git-versioned SQL + markdown, not a bespoke frontend. Every panel is a query over the
`evidence_*` DuckDB views (`waddle/_schema.py`), so extending it means writing SQL, and
an agent can add a page the same way. Three pages ship:

- **`/` overview** — KPI tiles, a filterable run table (project / status / name-search
  dropdowns, wandb-style), and a loss overlay across the filtered runs. Rows link to
  the deep dive.
- **`/runs/[run_id]` deep dive** — *generated for every run from data* (Evidence
  templated page): loss/lr/grad-norm curves, an any-metric selector, throughput and
  GPU/CPU/memory panels, and the full hyperparameter, tag, and provenance tables.
- **`/compare` comparison** — multi-select runs, overlay any metric, and a
  hyperparameter-diff table showing only the parameters that differ.

`waddle dashboard` keeps the underlying snapshot fresh on an interval, so the pages
track a running job. Liveness is snapshot-refresh (a few seconds), not socket
streaming — and it is fully decoupled, so the dashboard never touches the training
process or its DuckDB write lock.

### Adding a page

Drop a `.md` file in `evidence/pages/` with a fenced ` ```sql ` block against the
`waddle.*` sources (which wrap the `evidence_*` views) and any Evidence components.
No Python, no rebuild of waddle itself.

## Git Integration (Optional)

When you run `waddle.init()` inside a git repository:
- Auto-commits dirty working tree before the run
- Captures the commit SHA and links it to the run
- Records commit metadata (author, message, tree)
- Shows commit info in the dashboard

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

**Dashboard:** Node.js ≥18 — `waddle dashboard` installs the Evidence project's npm
deps into `evidence/node_modules/` on first launch. The Python package has no web deps.

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
    _schema.py           # DDL + evidence_* dashboard views
    _git.py              # Git detection (optional)
    _sysmetrics.py       # System monitor thread
    _types.py            # RepoInfo dataclass
    cli.py               # CLI: init, ls, dashboard
evidence/                # Evidence.dev dashboard (SQL + markdown)
    sources/waddle/      # DuckDB source over the evidence_* views
    pages/               # index, runs/[run_id] deep dive, compare
```

## License

MIT
