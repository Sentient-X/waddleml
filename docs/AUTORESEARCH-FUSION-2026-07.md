# Source fusion brief: autoresearch observation

Status: implemented and verified on 2026-07-19; the research-session hierarchy follow-up was
implemented and verified on 2026-07-20 after observing the first overnight M10 campaign.

## Objective

- Target capability: let an external optimization controller record candidate runs and let a
  person follow the live incumbent curve, branch tree, hypotheses, metrics, and source identity in
  the compact Waddle console.
- Target owner and vertical path: Autonomy owns the optimizer; `waddleml` owns the offline-first
  experiment ledger, hosted read API/MCP projection, and console. The first planned producer is
  Train's M10 edge-inference campaign; auto-perfect can later emit the same run facts.
- Compatibility required: yes. Existing `waddle.init` callers, DuckDB spools, hosted runs, metric
  ingest, reports, and run pages must remain valid. Ordinary runs carry no research record.
- Required parity: the supplied Weco dashboard recording's cumulative best curve, parent/child
  experiment selection, live state, and focused trial facts.
- Informative comparisons: Weco's code editor, chat analysis pane, hosted optimizer, branch
  steering, account/credit flow, and visual styling.

## Source identity and provenance

| Item | Identity/version | Location | License/attribution | Reproduced? |
|---|---|---|---|---|
| Weco CLI | commit `a377ca11ad0c67b30127f9dc182a2dd34b2125e6` (2026-07-02) | <https://github.com/WecoAI/weco-cli> | Apache-2.0 | Source and tests inspected; hosted dashboard code is not in the repository |
| Weco assistant skill | commit `29e57de643d49d198948622aedd7aaf9bbf4fe9c` (2026-06-30) | <https://github.com/WecoAI/weco-skill> | No repository license declared; concepts only, no copied text or code | Instructions and evaluation references inspected |
| AIDE implementation | commit `5d66a21771e98623dc9fc8716bdbe388d63464c0` | <https://github.com/WecoAI/aideml> | MIT | Not executed; search algorithm is outside this slice |
| AIDE paper | arXiv `2502.13138` (2025-02-18) | <https://arxiv.org/abs/2502.13138> | Paper citation required; no source copied | Abstract and algorithm framing inspected |
| UI reference | user-supplied 8.008 s, 1920x1080 H.264 recording | `/home/sentient/Downloads/zkhCrPvxAUO4RsOw.mp4` | User-supplied reference | Three evenly spaced frames inspected |

## Source claims and evidence

| Claim | Source evidence | Metric/protocol | Confidence or limitation |
|---|---|---|---|
| AIDE treats iterative code improvement as tree search over executable candidates. | AIDE paper and `aideml` README. | Conceptual algorithm and published evaluations. | High for the model; benchmark quality is not a Waddle claim. |
| Weco can observe a loop it does not control. | `weco observe init/log` in the pinned CLI, including `parent_step`, metrics, code snapshots, and failure state. | API/CLI contract inspection. | High; its hosted service was not reproduced. |
| A best-so-far trajectory and solution tree make long searches legible. | Supplied recording: baseline-to-step incumbent chart above a selectable solution tree and candidate detail. | Visual characterization. | High for the interaction; appearance is informative only. |
| Kernel optimization needs correctness before timing and stable measurement. | Pinned CUDA/Triton examples and Weco skill evaluation references. | Warm-up, repeated timing, differential output checks. | Directionally sound; Train M10's stricter frozen protocol remains authoritative. |

## Source algebra

### Objects

| Object | Identity | Invariants | Construction and destruction |
|---|---|---|---|
| Optimization session | One controller invocation | Append-only campaign phases belong to one human-legible run. | Created before the first phase; retained with all phase evidence. |
| Campaign phase | Campaign name plus objective and direction | One objective name and direction; append-only steps. | Derived from its candidates; retained without deleting its tree. |
| Candidate node | Run id plus step/node id | Has one parent except the root; status, hypothesis/plan, source, and metrics describe the same evaluation. | Appended by the controller; never rewritten into a different candidate. |
| Objective | Metric name plus minimize/maximize | Comparable finite values; direction is stable within a campaign. | Declared at campaign start. |
| Incumbent | Derived candidate | Best valid objective among the prefix of evaluated nodes. | Recomputed; never stored as independent truth. |
| Source snapshot | Candidate code or diff | The evaluated bytes match the node. | Captured before evaluation and retained for inspection. |
| Evaluation edge | Evaluation run → subject run | Names the exact candidate measured; stays inside one project/session. | Appended with the evaluation and never retargeted. |

### Operations

| Operation | Typed input -> output | Effect/failure | Cost |
|---|---|---|---|
| Start session | session identity -> research run | Establishes the top-level history that related phases join. | One typed field on each candidate; no parallel store. |
| Start campaign | session, objective, direction, source -> campaign id | Establishes immutable phase comparison context; rejects malformed input. | One metadata write. |
| Record candidate | campaign, parent, hypothesis, source identity, metrics, state -> node | Appends one node; failed candidates remain visible. | One evaluation plus metadata/metric writes. |
| Select incumbent | ordered valid nodes -> candidate | Applies min or max consistently. | Linear in visible nodes; derivable at query/UI time. |
| Inspect branch | selected candidate -> parent/children and facts | Read-only projection. | Metadata query plus optional artifact fetch. |
| Evaluate candidate | subject run, evaluator command -> evaluation run | Creates the run before execution, retains failure, and ingests scorecard/artifacts on success. | Evaluator cost plus ordinary Waddle writes. |

### Laws

| Law or statistical property | Domain | Counterexample boundary | Test oracle |
|---|---|---|---|
| Incumbent monotonicity | Finite objective values under a fixed direction. | Objective/direction changes, invalid or missing results. | Prefix minima never rise; prefix maxima never fall. |
| Rooted acyclic lineage | Candidates in one research session. | Missing parent, cross-session parent, self-parent. | Boundary validation and fixture tree traversal. |
| Stable session membership | Candidates in one campaign. | A campaign changes session midway. | Create-run boundary rejects a mixed session. |
| Evaluation identity | Evaluation and measured candidate. | Missing subject, self-subject, cross-project/session subject. | Typed `subject_run_id` boundary validation. |
| Failure visibility | Every attempted candidate. | Process dies before its local run is created. | Failed/aborted runs remain in campaign results and cannot become incumbent. |
| Evaluated-source identity | Candidate source and result. | Source changes during or after evaluation without a captured digest. | Git commit plus dirty-tree digest/artifact identity. |
| Observation does not own selection | External controllers. | A UI or tracker mutates candidate code or keep/revert state. | No optimizer mutation routes in Waddle. |

### Essential versus incidental

- Essential semantics: objective direction, append-only candidate identity, explicit parentage,
  visible failures, cumulative incumbent, source identity, and optimizer/observer separation.
- Incidental implementation choices: Weco's one-run/many-step storage, hosted-only API, silent
  `observe` exit code, embedded code editor, chat pane, credit model, and dashboard styling.
- Execution path from input to result and metric: an Autonomy controller proposes and evaluates a
  candidate, creates/finishes a normal Waddle run, the local DuckDB spool syncs metadata/metrics,
  the existing run API exposes typed research facts, and the console derives the tree and
  incumbent curve.

## Target concept map

| Source concept | Existing target concept | Relation | Pillar/owner | Decision and reason |
|---|---|---|---|---|
| External optimization session | `ResearchTrial.session_name` | Related campaign phases form one top-level Research run. | Waddle / Autonomy support | adapt; no session table is needed |
| External optimization phase | `runs.group_name` + objective/direction | One phase groups comparable candidate runs while preserving historical group-name reuse. | Waddle / Autonomy support | adapt; no campaign table is needed |
| Candidate step/node | Waddle run | A candidate gets full status, metrics, worker, git, log, and artifact semantics. | Waddle | adapt; finer provenance than hiding trials inside one run |
| `parent_step` | Typed research parent run id | Parent connects candidates within a session, including across phase boundaries. | Waddle | rederive; do not overload artifact lineage |
| Metric + maximize flag | Typed objective name + `ResearchGoal` | Stable campaign comparison contract. | Waddle | adapt |
| Best-so-far series | Derived prefix min/max | Chart projection over completed candidate summaries. | Waddle console | rederive; storing it would duplicate truth |
| Code snapshot | Existing commit, dirty-tree digest, and artifacts | Candidate source identity/detail. | Waddle | adapt; no code blob in Postgres |
| Evaluated candidate | Typed research subject run id | Evaluation nodes link to the exact candidate across phases. | Waddle / Autonomy support | adapt; do not overload artifact lineage or parentage |
| Weco optimizer/tree scheduler | M10 controller or auto-perfect agent | Proposes, evaluates, and keeps/reverts. | Autonomy | omit from Waddle; observation is the reusable seam |
| Derive/instruct/review mutations | Goal steering and controller policy | Human/agent search control. | Autonomy | omit from this slice |
| Hosted chat analysis pane | Existing run facts plus future agent report | Analysis is not authoritative experiment state. | Autonomy/Waddle reports | omit now |
| Fire-and-forget remote writes | Offline DuckDB spool plus retrying sync | Remote outage cannot stop evaluation; local ledger errors remain visible. | Waddle SDK | replace; silent local data loss is unacceptable |

Allowed decisions: `adopt verbatim`, `adapt`, `rederive`, `omit`, `replace`.

## Proposed normal form

- Minimal independent objects: ordinary Waddle run; `ResearchTrial` record (session, campaign,
  trial index, objective, direction, hypothesis, optional parent, optional evaluated subject);
  existing scalar metrics and source identity.
- Derived objects/operations: research-session list, ordered campaign phases, direction-adjusted
  attempt scatter plus accepted-incumbent staircase, graphical hypothesis/evaluation tree,
  evidence-derived working/discarded synthesis, per-phase rooted tree, baseline, current
  incumbent, delta, best run, progress curve, valid/failed counts.
- Boundary seams: one optional typed research record on `waddle.init`; the existing run-create
  API persists it; filtered run reads and MCP expose it; the console is read-only.
- Laws made explicit: one effective session per campaign-name family; objective/direction define
  a phase; parent and evaluated-subject links stay in the same session; nonnegative unique trial
  index by controller convention; finite objectives only; failed/aborted runs never become
  incumbent.
- Concepts and paths to delete: none. Existing run, metric, git, artifact, and sync paths are
  reused.
- Intentional compatibility breaks: none. The new record is absent for ordinary runs and old
  spools migrate additively.

## Benchmark contract

| Dimension | Dataset/input | Metric | Source target | Tolerance | Repetitions/seeds | Required? |
|---|---|---|---|---|---|---|
| Functional | Fixture with baseline, two branches, one failure, and later improvement | Exact tree edges, statuses, selected best, and prefix incumbent | Supplied UI semantics | Exact | Deterministic | yes |
| Compatibility | Existing SDK/server/UI test corpora and an old DuckDB schema | No regression; additive migration | Current Waddle behavior | Exact | Full focused suites | yes |
| Live projection | Running fixture gaining one candidate | New node and curve point become visible | Weco recording interaction | Within the console's 5 s poll interval | 3 updates | yes |
| Scale | 1,000 candidate metadata records | Selection and rendering remain usable | Informative only | API/UI response under 1 s on dev hardware | 3 | no, follow-up |
| Kernel quality | Train M10 frozen corpus and host | Correctness, p50/p95/p99, memory, sustained behavior | M10 definition of done | M10 tolerances | M10 protocol | outside Waddle |

- Source command and environment: pinned repositories were inspected from temporary, read-only
  snapshots; the hosted dashboard is represented only by the supplied recording.
- Fused command and environment: planned Waddle pytest suites, OpenAPI generation, TypeScript
  check, and Vite build from the glued workspace.
- Hardware, precision, budget, warm-up: irrelevant to the tracker parity slice; each producer
  records these as candidate config/metrics under its own frozen evaluator.
- Split, preprocessing, exclusions: no model dataset is used by Waddle. Optimizer quality and the
  Weco cloud service are excluded.
- Raw-result location: test output in the working session; durable source pins and decisions live
  in this brief. Kernel results remain under Train's M10 `.runs/` layout.

## Implementation sequence

1. Characterization/golden tests: SDK round-trip of typed research facts, old-spool migration,
   create-run validation, and min/max incumbent fixtures.
2. Smallest vertical slice: record research metadata on normal runs, sync it through the existing
   create-run path, filter/read it through API and MCP, and render a compact Research run index
   plus session detail page.
3. Replacement and deletion: none; reject any parallel campaign/node store introduced during
   implementation.
4. Target integration checks: local SDK tests, server contract tests, OpenAPI regeneration,
   UI typecheck/build, then one M10 baseline producer when its frozen evaluator lands.

## Results

| Metric | Upstream reported | Upstream reproduced | Fused | Tolerance | Verdict |
|---|---:|---:|---:|---:|---|
| Functional tree/incumbent behavior | Present in supplied Weco UI and canonical attempt/incumbent references | Characterized visually | Typed session/phase/parent/subject tree, all-attempt scatter, accepted-incumbent staircases, graphical hypothesis map, and evidence-derived synthesis | Exact fixture plus 76-trial desktop/mobile inspection | pass |
| Existing Waddle compatibility | n/a | Current tests are target baseline | 92 passed; OpenAPI regenerated; console typecheck and production build passed | No regression | pass |
| Kernel performance | Weco shows kernel use cases, not this model/device result | Not attempted | Owned by Train M10 | M10 contract | out of scope |

## Reduction ledger

| Measure | Added | Removed | Net | Justification |
|---|---:|---:|---:|---|
| Concepts | 1 typed research record | 0 | +1 | Parent/objective semantics cannot be inferred safely from arbitrary tags |
| Dependencies | 0 | 0 | 0 | Existing Pydantic, React Query, uPlot, and Waddle stores suffice |
| Files | 4 new, 26 modified | 0 | +4 files | Brief, compact Research page, and two previously missing/ignored formatting modules; API types are generated |
| Lines | 1,795 added | 118 removed | +1,677 | Includes the brief, generated OpenAPI, contract tests, and the full UI projection |

## Open evidence and decisions

- Unverified claims: Weco's hosted service scalability, optimizer quality, and exact dashboard
  implementation are not reproduced and will not become Waddle claims.
- Failed parity dimensions: live polling was type/build/desktop/mobile visually checked but not
  timing-measured; embedded code diff and chat analysis are explicitly informative rather than
  required.
- External blockers: no kernel campaign should start until Train M10 freezes a real model artifact,
  golden corpus, and deterministic evaluator. DGX Spark access needs a user-provided SSH alias.
- Follow-up decisions requiring user authority: remote Spark access and any later deployment of a
  promoted kernel; neither is required for this Waddle slice.
