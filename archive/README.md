# `archive/`

Retired surfaces kept for reference — nothing in here is wired to the CLI, the
server, or CI.

- **`evidence/`** — the Evidence.dev local dashboard (SQL + markdown pages over the
  `evidence_*` DuckDB views), retired 2026-07-19. Superseded on both fronts: the
  hosted console (`ui/`, :5179) is the passive always-on dashboard, and the glued
  `waddle-dashboard` agent skill is the laptop-local analysis story. The `waddle
  dashboard` CLI command and its snapshot/refresh helpers were deleted with it.
  The `evidence_*` views themselves live on in `waddle/_schema.py` — they are the
  skill's read contract. To resurrect this project: `npm install` in `evidence/`,
  copy a spool snapshot to `evidence/sources/waddle/waddle.duckdb`, `npm run dev`.
