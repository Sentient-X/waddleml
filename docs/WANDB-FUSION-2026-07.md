# Source fusion brief: wandb artifact-lineage laws → waddle

## Objective

- Target capability: complete the waddle artifact lineage DAG — runs consume artifacts, not
  only produce them — by adopting wandb's two artifact laws: `use_artifact` (a typed **input**
  edge from a run to an artifact version) and content-identity versioning (committing identical
  content **reuses** the existing version instead of conflicting, and still records the edge).
- Target owner and vertical path: `waddleml` (SDK `waddle/` + `waddle_server/`). Vertical
  path: `Run.use_artifact()` → spool row (`relation`) → sync commit (`relation: input`) →
  Postgres `artifact_lineage` → `GET /api/v1/runs/{id}/lineage` / `waddle.runs.lineage` MCP.
- Compatibility required: **no** (glued-internal platform; SDK and server ship from one tree).
  One deliberate semantic replacement: same-digest commit stops being a 409 conflict.
- Required parity: functional parity with wandb's laws (input edge recorded; identical-content
  commit is idempotent and version-stable), pinned by waddleml's own test suites.
- Informative comparisons: none — wandb's implementation is a Go sidecar + cloud backend;
  nothing is benchmarkable against it locally.

## Source identity and provenance

| Item | Identity/version | Location | License/attribution | Reproduced? |
|---|---|---|---|---|
| Repository | wandb/wandb @ `9f5dcee2dac1ff713a74de6ae555b9eed002b199` (0.28.2.dev1, cloned 2026-07-20) | /tmp/fuse-wandb (disposable) | MIT (© 2021 Weights and Biases, Inc.); no code copied verbatim — laws rederived, so no notice carried | semantics read from source; runtime not reproduced (backend is a cloud service) |

## Source claims and evidence

| Claim | Source evidence | Metric/protocol | Confidence or limitation |
|---|---|---|---|
| `use_artifact` declares an input lineage edge; `log_artifact` an output edge; together they form the run↔artifact DAG | `wandb/sdk/wandb_run.py:3140` (use), `:3266` (log) | API contract | high; DAG materialization is server-side (invisible in repo) |
| Logging an artifact whose content digest equals the latest version creates **no new version** (idempotent by content) | `wandb/sdk/artifacts/artifact.py:1056` docstring; server-assigned `v0..vn` | API contract | high for the law; enforcement server-side |
| Aliases (`latest`, `best`) are mutable pointers onto immutable versions | `artifact.py:929-943` | API contract | high |
| Summary/define_metric/alerts/resume-fork-rewind semantics | see concept map | — | audited; deliberately not adopted (below) |

## Source algebra

### Objects

| Object | Identity | Invariants | Construction and destruction |
|---|---|---|---|
| Artifact version | (collection, digest) — digest of the sorted file manifest | immutable once committed; version numbers monotone per collection | committed by a producing run; never deleted by SDK |
| Lineage edge | (run, version, relation) with relation ∈ {input, output} | set-valued (duplicate declaration is a no-op) | recorded at log/use time |
| Alias | (collection, name) | mutable pointer to one version | set/moved explicitly |

### Operations

| Operation | Typed input → output | Effect/failure | Cost |
|---|---|---|---|
| `log_artifact(path/artifact)` | file set → version ref | new version, or reuse if digest unchanged; output edge | hash + upload (deduped) |
| `use_artifact(name:alias)` | ref → version handle | input edge; download access | resolve + edge insert |

### Laws

| Law | Domain | Counterexample boundary | Test oracle |
|---|---|---|---|
| Content identity: same manifest digest ⇒ same version | per collection | different collection ⇒ different version | commit twice, version count = 1 |
| Edge totality: every log/use records its edge, including on version reuse | all commits | waddle pre-fusion dropped the edge on digest match (409 swallowed) | lineage query after duplicate commit |
| Producer-only provenance: `created_by` is the producing run; consumers never claim it | input edges | — | input commit leaves created_by unchanged |
| Relation is a closed vocabulary {input, output} | wire | unknown relation fails closed | schema validation |

### Essential versus incidental

- Essential semantics: the three laws above; two verbs (produce vs consume) rather than a
  relation parameter at user call sites.
- Incidental: Go sidecar + protobuf transport; GraphQL resolution of `name:alias`; draft
  artifacts, incremental artifacts, TTL, distributed upsert — wandb machinery waddle's
  session→blob→commit flow does not need.
- Execution path: SDK hash → upload-session (org-scoped blob dedup) → commit(relation) →
  version reuse-or-create + lineage insert → lineage read (HTTP + MCP).

## Target concept map

| Source concept | Existing target concept | Relation | Pillar/owner | Decision and reason |
|---|---|---|---|---|
| `init/log/finish/config/tags` module API | same | same | waddle | already adopted |
| `use_artifact` (input edge) | `artifact_lineage.relation='input'` exists server-side with **zero writers** | missing (writer half) | waddle | **adopt (adapted)** — completes a half-built cross-repo handoff; serves the lineage-moat strategy |
| Content-identity versioning (reuse on same digest) | 409 `artifact_digest_exists`, edge dropped | conflicts | waddle | **replace** — idempotent commit fixes a live lost-edge bug and deletes the SDK's 409 special case |
| Producer-only `created_by` | commit sets `created_by_run_id` for any relation | refines | waddle | **adopt** — consumers must not claim provenance |
| Aliases in SDK (`latest`/`best`) | server `set_alias` endpoint exists; no SDK verb, no reader (console/MCP don't surface aliases) | partial | waddle | omit — a second zero-consumer surface would violate glued rule 2; revisit with a real consumer |
| `run.summary` + `define_metric` aggregation config | read-time projections (`evidence_run_metric_latest`, `/query/latest`, autoresearch staircases) | refines | waddle | omit — waddle derives summaries at read time from the full spool; a client-side aggregation config re-introduces a hand-kept parallel truth |
| `log(commit=False)` accumulation, step-forward-only law | per-row spool + decimation views; resume attempts | conflicts | waddle | omit — accumulation is an artifact of wandb's history-row wire format; the spool records facts, views shape them |
| resume `allow/must/never/auto`, `fork_from`, `resume_from` (rewind) | `resume=True` + attempt numbers (immutable earlier attempts) | target simpler and stronger for its consumer (train) | waddle | keep target |
| `wandb.alert`, `mark_preempting` | none | missing | waddle | omit — no notification substrate; an unwired alert API is fiction (glued rule 8) |
| Media types (Image/Table/Histogram/…) | Rerun `.rrd` via `sx-telemetry`; artifacts for blobs | conflicts | platform | omit — the platform's rich-media substrate is Rerun |
| Filestream batching (15 s / size-capped, retry) | `SyncEngine` (1 s flush, persisted outbox, byte-identical replay) | same (target stronger: durable spool) | waddle | keep target |
| Offline `.wandb` log + `wandb sync` | DuckDB spool + `waddle sync` | same (target queryable) | waddle | keep target |
| Terminal run-URL header/footer | none | missing | waddle | omit here — separate diff if wanted (one problem per diff) |

## Proposed normal form

- Minimal independent objects: artifact version (content-identified), lineage edge
  (run × version × `ArtifactRelation`), alias (unchanged, server-only).
- Derived: `GET /runs/{id}/lineage` and `waddle.runs.lineage` (unchanged shape).
- Boundary seams: the relation vocabulary is typed once per side — SDK `ArtifactRelation`
  (str-Enum, py3.9) and server `ArtifactRelation` (StrEnum in `schemas.py`, replacing the
  stringly `pattern="^(input|output)$"` field) — byte-equal wire values pinned by tests on
  both sides (the SDK cannot import server code; purity budget).
- Laws made explicit: content identity, edge totality (including on reuse), producer-only
  provenance, closed relation vocabulary.
- Concepts and paths to delete: `ArtifactConflictError` + the 409 `artifact_digest_exists`
  branch; the SDK's swallow-409 special case narrows to genuinely-broken sessions.
- Intentional compatibility breaks: duplicate-content commit returns the existing version
  (200) instead of 409. Only known committer is this SDK, which treated 409 as success —
  no consumer observes a behavior regression; the server test pinning 409 is updated in the
  same change.

## Benchmark contract

Pure semantics fusion; no performance dimension. Required evidence is the test suite:

| Dimension | Input | Metric | Required? |
|---|---|---|---|
| Functional | duplicate-content commit (two runs, same bytes) | 1 version; 2 output edges | yes |
| Functional | `use_artifact` roundtrip | input edge in lineage; created_by unchanged; no new version | yes |
| Functional | SDK spool + sync | `relation` recorded locally and sent on the wire for both verbs | yes |

- Source command: not runnable (cloud backend); laws taken from source code as cited.
- Fused command: `pytest tests/` (SDK, offline-safe) and `pytest tests/server/` (dev Postgres).

## Implementation sequence

1. Characterization: existing `test_upload_commit_lineage_roundtrip` pins current 409
   behavior — updated deliberately in the same change (documented break).
2. Smallest vertical slice: SDK `use_artifact` → spool `relation` column → sync passthrough →
   idempotent server commit + lineage-always → existing lineage reads.
3. Replacement and deletion: `ArtifactConflictError`, 409 digest branch, stringly relation
   field.
4. Target integration checks: `pytest tests/`, server suite, pyright (server budget), README/
   AGENTS/ARCHITECTURE updates.

## Results

| Metric | Upstream | Fused | Verdict |
|---|---|---|---|
| Input edge recorded by SDK verb | `use_artifact` law (source-cited) | `test_use_artifact_records_input_edge`, `test_artifact_upload_carries_relation`, server input-edge assertions in `test_upload_commit_lineage_roundtrip` | pass |
| Content identity (1 version per digest; edge still recorded on reuse) | wandb law | duplicate-content commit → 200, v0 reused, second run's edge present | pass |
| Producer-only provenance | wandb law | input commit leaves `created_by_run_id` on the producer | pass |
| Suites | — | SDK `pytest tests/` 43 passed; server `pytest tests/server/` 57 passed; pyright 39 errors vs 42 pre-change baseline (changed production files clean) | pass |

## Reduction ledger

| Measure | Added | Removed | Net | Justification |
|---|---:|---:|---:|---|
| Concepts | `ArtifactRelation` (typed, both sides), `use_artifact`, `CommitOutcome` | `ArtifactConflictError` + 409 digest-conflict semantics + stringly `relation` field | ~+1 | the relation vocabulary existed as an unenforced string pattern; now it is the wire type with a writer for both values |
| Dependencies | 0 | 0 | 0 | SDK stays stdlib+duckdb (purity test green) |
| Parallel paths | 0 | 1 | −1 | the SDK's swallow-409-as-success special case for duplicate digests is gone; one commit path, idempotent by content |

## Open evidence and decisions

- Unverified upstream claims: wandb server-side DAG materialization details (cloud, closed) —
  irrelevant to the adopted laws.
- Known pre-existing gap, out of scope: `waddle sync` (CLI backfill) does not backfill
  artifacts at all — live sync only. Applies equally to both relations.
- Follow-ups landed as their own diffs (2026-07-20): the sync engine prints the hosted run
  page on registration (`RunRef.url` finally consumed); min/max over the attempt-deduplicated
  stream on `evidence_run_metric_latest` and `/query/latest` (wandb's summary min/max as
  read-time projections, no client-side aggregation config — the `latest` query also stopped
  letting a resumed attempt's earlier step pose as the latest value). Still deferred: SDK
  alias verb once something reads aliases.
