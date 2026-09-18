# Generic gameplay harness extraction

Current implementation and remaining acceptance work: [completion checklist](COMPLETION-CHECKLIST.md). Dated milestones below are historical evidence.

Status: in progress. Baseline: `fd777f7` in the demo repository.

The requested end state is a standalone TypeScript harness, consumed through a
Git submodule, that drives the existing Doom application and supports other games
through explicit adapters. The browser is a consumer, not part of the engine.
No claim of automatic support for arbitrary games or model-weight training is
made: games must supply an adapter, and training backends are separate providers.

## Required delivery and evidence

1. A standalone repository mounted at `harness/`, with public typed exports,
   its own build/typecheck/test workflow, documentation, and no parent imports.
2. A headless core owning sessions, trials, budgets, cancellation, promotion,
   recovery, experience retention, persistence and replay ancestry. Core code
   must not import Doom, Jev, Microsandbox or React or assume a game tick rate.
3. Game contracts for observations and their provenance, candidate plans,
   execution/interruption, capabilities, clocks, progress and measured outcomes.
   Exact branching, checkpoint restore and replay are distinct capabilities.
4. Replaceable runtime, decision-model, storage and optional supervisor ports.
   Resolved policy layering is defaults -> adapter -> profile -> session; validate
   backend values and record versions with decisions and persisted artifacts.
5. Doom consumes the public harness interfaces. Preserve its current observable
   controls, detached sessions, selected replays, cleanup and recovery. Existing
   persisted runs and checkpoints must be qualified before the live app switches.
6. A non-Doom turn-based fixture drives the same core without Doom-shaped fields.
   Adapter contract tests cover immutable sources, divergent children, cancellation,
   fair trials, unsupported capabilities, cleanup failures, restore and terminal
   states. Then qualify a second existing game with an isolated runnable example.
7. The supervisor can modify and evaluate the learning system itself, including
   policy/configuration and isolated executable revisions, as described in
   [SUPERVISOR-DESIGN.md](SUPERVISOR-DESIGN.md). Supervisor review/intervention is separate from the decision model and user
   guide. Add it after core extraction. Validate scope, capabilities, lifetime,
   budgets and stale results, preserve branch-local facts, and record evidence.
8. Reproducible headless experiments compare policies with matched total compute
   and simulation budgets; record seeds/builds/profiles, all futures, outcomes,
   costs and failures. Export experience data without calling inference-time
   memory model training. Supervisor off/on comparisons require explicit evidence.
9. Run package checks, all existing application checks, real isolated Doom VM
   smoke, restart/checkpoint/replay qualification and browser verification. Record
   what is tested, what is incomplete and any performance limitations.

## Implementation approach

Extract small reusable modules and connect the existing application incrementally.
Do not replace the tested lifecycle with an unverified parallel implementation or
leave the demo using its old core while describing extraction as complete.

Keep domain observations, input types, plan payloads and experience features typed
at the adapter boundary. Avoid a universal dictionary of optional game fields or
inheritance that forces every game into a Doom-shaped schema. Core dependencies
point toward small interfaces; integrations implement them. Every long operation
accepts cancellation and has an explicit owner and cleanup rule.

Preserve the committed baseline and use isolated test worlds. No production game
reset, unreviewed outcome-policy changes, or implicit supervisor goals as part of
extraction. A new storage schema must have a tested import path or a clear refusal.

## Repository setup

The demo currently has no remote. Until a hosting location is supplied, create a
local sibling repository and reference it as a Git submodule. Publishing repositories
is separate from extraction. A local URL is not a publicly cloneable dependency;
replace it with the chosen remote before sharing the parent repository.

## Extraction evidence, 2026-09-17

The mounted package is now used by the Doom application, with the existing
session JSON and compressed recording formats preserved:

| Extracted responsibility | Public package entry | Application integration |
| --- | --- | --- |
| Relevant attempt retrieval and bounded retention | `EvidenceMemory` | `experience.ts` supplies Doom matching/capture rules |
| Serialized atomic persistence | `/node` `JsonFileStore` | `SessionStore` supplies the existing version-1 decoder |
| Recording chunks, selected ancestry and retention | `/node` `ReplayStore` | `Recordings` supplies Doom's frame cursor and legacy fork cursor |
| Learning-cycle ordering and cancellation boundaries | `LearningLoop` | `Session.cycle` delegates through game-specific planning/comparison/recovery ports |
| Confidence routing and retry candidate rotation | `routeDecision` | `Session.cycle` supplies eligible Doom candidates and stall detection |
| Judgment freshness and bounded request retries | `decideCurrent` | `Session.ask` supplies current guide/skills revisions and the Jev provider |
| Equal-duration independent futures and cancellation fence | `runTrials` | `Session.explore` supplies Doom plan/input execution |
| Exclusive session operation ownership and presentation pacing | `ExecutionGate`, `waitFor` | play, pause and takeover use the same gate |
| Durable fork intent and restart reconciliation | `WorldForks` | Doom supplies validated observations and trial metadata; runtime creation is journaled and recovered by physical identity |
| World registry, durable promotion and runtime cleanup | `WorldLifecycle` | `Session` delegates its registry, main identity and cleanup journal; UI comparison changes participate in publication rollback |
| Execution-checkpoint transactions and retention | `CheckpointRecovery` | Doom supplies checkpoint payloads, exact-state validation and Microsandbox operations |
| Dependency-aware artifact cleanup | `collectLeafArtifacts` | Microsandbox adapter translates indexed snapshot identities and keeps the runtime deletion guard enabled |

Trial horizons are captured before dispatch. The runner validates clocks and
budgets, joins siblings after a failure, and retains the original failure cause.
A new guard stops a future after 64 consecutive transitions with no simulation
time advancing; this prevents unbounded immediate replanning. Instruction changes are limited to eight successive decision attempts before an
explicit error; provider failures are not retried. Invalid confidence or candidate
probabilities fail explicitly rather than silently bypassing routing. Normal plan and
single-action behavior is otherwise covered by the existing session tests.

Validation performed:

- Standalone package build, typecheck and 23 tests passed. A fresh clone of
  `be181f2` outside the demo also passed `npm ci --ignore-scripts` and
  `npm run check`, with no parent dependencies or lockfile changes. Turn-based fixtures
  exercise independent progress, terminal states, cancellation, resumed budgets,
  first-failure preservation, frozen adapters and changes to in-flight controls.
- The initial 93 application tests passed after trial/gate/cleanup integration.
  A subsequent full run, including concurrent application additions, passed 98 tests.
- Application typecheck and production build passed.
- `npm run smoke:session` passed against real isolated Microsandbox VMs and Jev.
  It creates detached futures, exits the creating process, reconnects, promotes a
  winner, checks stitched replay ancestry and accepts human input. The smoke now
  also captures/restores an execution checkpoint, asserts exact state and frame
  equality, and verifies the restored replay excludes the abandoned continuation.
  Restart and cleanup affect only smoke-owned worlds and footage.

Additional lifecycle qualification:

- The world registry, promotion and checkpoint operations now use the shared
  harness. Failed publication restores source roles, runtimes and metadata before
  releasing any VM. Failed cleanup keeps the selected world and the exact failed
  runtime identities queued. Checkpoint GC is serialized with restore publication
  and cannot consume uncommitted pruning decisions.
- Standalone commit `d2e1340` also passed its full checks in the separate
  qualification clone outside the demo.
- 37 package tests and 106 current application tests pass, including publication
  failure, partial cleanup, interrupted capture/restore, state mismatch, retention
  and a collector queued behind a failed restore transaction. Typecheck and the
  production build pass. The real-VM smoke passed after lifecycle integration.
- `apps/server/fixtures/session-fd777f7` was produced by the unchanged session and
  recording code at the pre-extraction commit. The compatibility test loads its
  version-1 session and compressed recordings, reconnects, promotes a future,
  checks replay ancestry, restores a checkpoint and persists the resulting session.
  Its runtimes and frames are test fixtures, independently of the real-VM smoke.
  Regenerate with `node --import tsx scripts/qualification/generate-legacy-session.ts`.
- Comparison batches now use random, registry-checked IDs. The new registry
  exposed an existing millisecond-ID collision during fast retries, previously
  capable of overwriting an archived world. Existing IDs remain readable.

These results do not establish completion of the full extraction. Retry policy, supervisor revision activation and
parts of plan execution still live in the Doom application. The full non-Doom
session fixture, second existing game, revision supervisor, matched-budget
evaluation and browser qualification remain pending. No live application restart
or run reset was done for this extraction stage.

Concurrent UI/video-export changes are present in the parent checkout; they are
outside this extraction's changes and must be preserved when staging commits.

Shared learning loop qualification:

- Doom now delegates cycle ordering to `LearningLoop`: checkpoint, decide, act or
  compare, review, promote, retry/recover and continue. Game-specific mechanics,
  scoring, VM budget admission and saved-session fields remain adapter-owned.
- 46 standalone tests pass, including a turn-based shared-loop fixture using the
  real trial runner and world lifecycle. It checks immutable source state, whole
  winner promotion, direct continuation, terminal recovery, rejected comparisons,
  retry rotation, manual overrides, pinned limits, cancellation and failures.
- 106 application tests and application typecheck pass. The isolated real-VM
  smoke passed again after loop integration, including Jev, detached reconnect,
  exact checkpoint restoration, selected replay ancestry and cleanup.

Policy provenance qualification:

- `resolvePolicy` supplies fixed defaults → adapter → profile → session layering,
  immutable validated values and explicit layer versions. `/node`
  `contentRevision` hashes canonical JSON, rejecting values that JSON would
  silently discard or reinterpret.
- Doom uses this resolver when asking for a decision. Session checkpoints retain
  a verified policy catalogue; decisions, worlds, pending forks, execution
  checkpoints and recorded frames reference their corresponding policy. Routing
  receives a separate reference when controls change while a judgment is pending.
  The captured trial horizon remains unchanged. Existing version-1 runs without
  policy metadata are still imported and are not falsely assigned old provenance.
- 50 package tests and 108 application tests pass. Tests verify layer precedence,
  replacement semantics, immutability, content identity, invalid data, catalogue
  save/restore, replay references and mid-judgment control changes. Application
  typecheck, production build and isolated real-VM smoke pass after integration.
- This is parameter-policy provenance, not full executable/model version tracking
  or supervisor activation. Those boundaries and matched-budget evaluation remain
  unfinished. Explicit game restart clears the catalogue after old recordings
  have been cleared successfully.


Matched-budget evaluation foundation:

- `BudgetLedger` reserves resources across all worlds before dispatch. Confirmed
  unused capacity is released; failures and interrupted operations retain their
  reservations. Atomic persistence can journal pending work before execution.
  A detected reservation overrun stops subsequent work. Cancellation joins work.
- `compareRevisions` pins scenarios, seeds, budgets and acceptance criteria. It
  alternates baseline/candidate order, rejects incomplete/error/timeout runs,
  checks total accounting and applies both mean-gain and per-scenario regression
  gates. The trusted host owns resource metering and evaluation, separate from
  mutable revision code. Executable revision isolation/activation is still pending.
- `npm run evaluate:harness -- --simulation-ticks=560 --model-calls=4 --scenarios=0
  --candidate-threshold=1` runs the existing Doom engine with the live Session
  and Jev, using replay reconstruction for clones. All initialization, setup,
  discarded simulation and reconstruction ticks count. It writes manifests, code
  snapshots/hashes, policy catalogues, world observations, decisions, budget
  journals and reports to a new `artifacts/harness-evaluation/` directory.
- Jev now exposes the API's reported input/output token counts. Calls and total
  simulation are hard-capped in this driver; tokens are measured after the
  response and are explicitly uncapped. Unknown token cost after a failed call
  is not described as zero actual use. This is not a matched-token-cost claim or
  a Microsandbox snapshot/performance benchmark.
- 64 harness tests and 111 application tests pass, including real Doom
  reconstruction accounting and partial-fork budget exhaustion. Typecheck passes.
  A 280-tick/two-call diagnostic pair tied and was rejected. A 560-tick/four-call
  pair with candidate threshold 1 exercised futures and was rejected: baseline
  score 10105, candidate 10102 under the fixed illustrative metric. These tiny,
  previously used starts validate execution/reporting, not gameplay quality or
  held-out acceptance. No live session settings or worlds were changed.


Fork lifecycle qualification:

- Doom now uses `WorldForks` for durable intent, acknowledged runtime identities,
  validated attachment, atomic registry/trial publication and interrupted-fork
  reconciliation. Source and trial bounds are captured before dispatch. Returned
  child order does not determine candidate identity. A failed provider call keeps
  its intent instead of assuming no children exist.
- Resume, compare and restart commands reconcile an interrupted fork first.
  Missing children are reported and are not recreated. Replaced physical identities
  or mismatched observed game state are refused. Failed final publication restores
  application trial metadata while retaining the exact runtime recovery record.
- Failed Microsandbox batch cleanup now joins every child cleanup before returning
  an error. Skill edits during VM admission also invalidate the older captured
  judgment instead of giving it the newer skill revision.
- 73 standalone tests and 115 application tests pass. Package/app typecheck pass.
  The normal real-VM session smoke passed after integration, including Jev,
  detached reconnect, promotion, exact checkpoint restoration and replay ancestry.
- `npm run smoke:fork-recovery` additionally injected a host publication failure
  after two real child VMs were created, exited that process, then recovered from
  a new process. It verified the same physical child identities, exact state and
  PNG frames, completed their trials and promoted a winner. Decisions in this
  failure-injection test are a deterministic fixture; its runtime is real.

Supervisor revision controller qualification:

- `RevisionController` now owns a durable catalogue, proposals, qualifications,
  active epoch and complete activation/rollback history. It derives changed
  capabilities, checks proposal lifetime, binds evaluations to the fixed contract
  and user-context identity, and rejects results from an obsolete active epoch.
  Returning to an older revision does not make its old proposals current again.
- The host fences decisions/context changes during activation. The controller
  verifies artifacts and state compatibility, then persists the new pointer before
  exposing it. Failed write acknowledgments require reopening authoritative
  storage. Restart retains interrupted evaluations without silently replaying
  their compute/model costs. Rollback can only target a previously active artifact.
- 88 standalone tests pass. The added tests exercise accepted/rejected fixed-budget
  comparisons, activation fencing, publication uncertainty, restart/rollback,
  stale context and baseline epochs, expiry, cancellation joins, identity mismatch,
  malformed history and denied capabilities. All 115 application tests and
  application typecheck pass.
- `npm run evaluate:harness -- --supervise --simulation-ticks=560 --model-calls=4
  --scenarios=0 --candidate-threshold=1` connects the controller to real Doom/Jev
  evaluation. It persists `supervisor.json`, the comparison and an active profile,
  then reopens the journal from disk and verifies the complete recovered state.
  The isolated experiment rejected the candidate (10102 vs 10105), retained the
  baseline at epoch 0, and recorded 546 candidate vs 273 baseline simulation
  ticks and two vs four model calls under the same caps. Evidence is in
  `artifacts/harness-evaluation/2026-09-18T03-28-02.250Z`.
- This is policy qualification in an isolated headless experiment. It does not
  activate revisions in the live Doom server or isolate/load executable revisions.
  The diagnostic scenarios and default provider model are not held-out/pinned
  acceptance evidence. A tested improving executable revision, live boundary
  integration, second existing game and full end-to-end audit remain pending.
- Standalone signed commit `326ae47` passed all 88 checks/tests plus build in the
  independent qualification clone. The application production build also passed.
  The live server/session was not restarted or reset for this work.

Executable revision isolation and initial existing-game qualification:

- The core exports a source manifest, executor limits/receipt/provider contracts,
  and `/node` content-addressed `ExecutableStore`. Candidate TypeScript is stored
  and verified as data; no proposed code or build/install hook runs on the host.
  Optional executor-call and observed-wall-time resources extend the budget ledger.
- `packages/executor-microsandbox` supplies the provider independently of Doom.
  It verifies resolved networking/mount/resource restrictions, loads sources into
  a fresh VM using a pinned Node image, runs as uid 1000 with a cleared environment,
  streams bounded output, enforces a deadline and joins full-VM cleanup. Durable
  creation/runtime records support cleanup after host interruption.
- `npm run smoke:executor` passed against real VMs: relative TypeScript imports,
  host file/environment isolation, loopback-only networking, excessive-output
  rejection, infinite-loop timeout, explicit cancellation of running code and
  destruction of all invocation VMs. Its second process recovered an interrupted
  invocation; an incorrect physical identity was refused before actual cleanup.
- `npm run qualify:executor` passed with 13 real VM invocations. It reuses
  `chess.js@1.4.0`, pinned in package.json/package-lock.json, rather than building a
  new game. The host rejected illegal output/self-reported success; an executable
  mate selector improved all three fixed cases, was activated and read back from
  disk, then achieved checkmate in a fresh continuation. Rollback restored the
  baseline at epoch 2, preserving both evaluations. Evidence is retained at
  `artifacts/executable-qualification/2026-09-18T03-46-16.997Z`.
- 93 core tests and 118 application/example tests pass with typecheck. Chess
  runtime tests verify immutable sources, divergent forks and exact saved history
  across threefold repetition. These are deterministic contract/source fixtures,
  not autonomous discovery, broad playing strength or held-out learning evidence.
  A complete shared-loop second-game example, live revision integration, automated
  source proposal generation and the final requirement audit remain outstanding.
- Standalone signed commit `4cd30fb` also passed build/typecheck and all 93 tests
  in the independent qualification clone. The application production build passed.
  The existing live Doom server and game state were not restarted or reset.

Existing-game shared-loop session qualification:

- `examples/chess/` now composes the public `LearningLoop`, `WorldForks`,
  `WorldLifecycle`, `CheckpointRecovery`, `EvidenceMemory`, `ReplayStore`,
  `ExecutionGate` and policy resolver around the existing chess.js engine.
  The CLI supports continued play, status, complete selected-path replay and
  rollback. Its runtime persists exact move history locally; these game forks
  are file-backed clones, not VMs or a VM-fork performance claim.
- Contract tests cover equal-length futures, immutable source state, whole-state
  promotion, process reconnect, retained replay ancestry, checkpoint GC/rollback,
  stale guidance, pause/resume, partial fork failure and physical identity recovery,
  tampered checkpoints and terminal states. Input intent is persisted before
  dispatch; reconnect distinguishes an unexecuted move from its exact acknowledged
  result. Unjournaled movement is refused rather than adopted silently.
- Discarded futures contribute both per-input and full-trial measured experience.
  A queen-capture fixture demonstrates why this matters: its immediate gain is
  followed by a recapture and net material loss. The complete loss is retrieved
  after rollback. Guidance changes during fork creation update feedback attribution
  to the move actually played, rather than the abandoned opening proposal.
- The default deterministic decision fixture remains available. An optional Jev
  implementation of `DecisionModel` now sends board/legal moves, current statistics,
  user guidance and observed outcomes. It records requests, raw responses, serving
  model and tokens. The shared `BudgetLedger` reserves API calls before dispatch,
  including discarded futures and failed/interrupted requests, and retains the cap
  across restarts. No retries or hard token/spend cap are implied.
- A real Jev run at `.cache/chess-jev-qualification-20260918` completed two
  comparisons in separate CLI processes with a guidance change. Six API calls
  served by `jev-1.13.0` consumed 8186 input / 1255 output tokens. Whole-state
  promotions retained `e4 Nf6 Nf3 Nxe4`, and frame 4 replayed from the stitched
  history. This line loses a pawn and is integration evidence, not strong chess
  play, calibrated confidence or a held-out improvement result.
- The chess CLI also ran with the deterministic provider across separate run,
  replay, rollback and resume invocations. Automatic checkpoint retention,
  selected footage and global attempt counts survived. No live Doom session was
  restarted or reset. See `examples/chess/README.md` for commands and limitations.
- Rollback of that saved Jev session restored ply 0 while retaining eight attempted
  plies, twelve experience records and all six charged calls. A new process replayed
  the restored initial frame without additional model calls.
- All 16 focused chess tests, 132 application/example tests and application
  typecheck pass. The production build passed. Core source and its signed submodule revision were
  unchanged in this stage. Autonomous revision proposals, live supervisor activation,
  fixed held-out comparison and final browser/requirement audit remain outstanding.

Continuing-session executable revision activation:

- The optional chess learning binding reads the `RevisionController` as the sole
  authoritative active pointer. It pins one artifact for each cycle/comparison,
  resolves historical activation epochs on reconnect, and records policy/model/
  adapter/executor identity in worlds, checkpoints and replay frames. Existing
  unsupervised chess sessions remain readable without a supervisor binding.
- `revisionBoundary` refuses activation during a decision or unresolved batch and
  fences guide edits during publication. Session tests cover stale guide rejection,
  sibling revision consistency, whole-state rollback with historical provenance,
  using the currently active revision after world rollback, invalid saved references,
  and an acknowledged disk write followed by lost publication acknowledgment.
- `ChessExecutableModel` runs candidate source only through the isolated provider,
  passes policy/prompts/skills with the explicit request, validates the returned
  distribution against legal candidates and reserves invocation costs. Host rules
  still own state transitions and the independent acceptance metric.
- `CheckpointRecovery` accepts an optional retention getter. It validates and pins
  that value before each capture; asynchronous changes cannot alter the in-flight
  pruning decision. Fixed numeric limits retain constructor semantics, and the
  checkpoint journal format is unchanged. Signed standalone commit `a673881` is
  synchronized to the sibling repository and parent gitlink; no remote publication.
- `npm run qualify:executor` passed in three distinct processes with 15 real VM
  invocations. Invalid output was rejected; the improved source satisfied every
  fixed mate case. A continuing session restarted at epoch 1, played `Qe8#`, and
  retained a complete two-frame replay. After revision and world rollback, another
  process resumed the baseline at epoch 2 with three cumulative attempted plies.
  The live continuation consumed exactly three input and three executor-call
  reservations. Every invocation was released; a provider query returned no
  remaining executor sandboxes. Evidence is retained under
  `artifacts/executable-qualification/2026-09-18T04-36-20.815Z` with source/build
  hashes, independent comparisons, budgets, receipts and all three process IDs.
- All 94 standalone and 137 application/example tests pass, with typecheck and
  production build. The independent standalone checkout also passes its full check.
  The live Doom app remains HTTP 200; its session was not reset or restarted.
- This closes the controlled continuing-session revision/recovery path in the
  second game. It does not establish autonomous source discovery, held-out gameplay
  improvement, live Doom activation, an Exo outer provider or the final browser and
  complete-requirement audit. Those remain part of the original unfinished goal.


Autonomous outer-provider integration and qualification:

- Signed standalone commit `2fdab29` adds `SupervisorProvider`, bounded proposal
  request/receipt contracts, durable `supervisorCalls` accounting and expected
  activation/context checks before accepting asynchronously generated proposals.
  The sibling repository and parent gitlink are synchronized. Its independent
  checkout passes all 97 package checks/tests.
- The application supplies a tool-free Claude Code adapter with explicit model/
  effort provenance, bounded process input/output, spending cutoff and an
  independent watchdog. Cancellation, SIGINT/SIGTERM and host death reap its
  process group. Usage reconciles overlapping aggregate/per-model totals without
  losing auxiliary usage on failed invocations.
- `npm run qualify:supervisor` gathered two actual baseline stalemates, requested
  one complete source proposal, then independently measured the unchanged artifact
  on three different acceptance positions. The successful run is
  `artifacts/executable-qualification/2026-09-18T05-08-11.230Z`: baseline 0/3 mates,
  Claude-generated candidate 3/3. Three processes verified activation, continuation
  after restart, complete replay and rollback to the original code at epoch 2.
  All 17 real executor VMs were released; provider inventory was empty afterward.
- The successful generation used medium effort, took 72.611 seconds and reported
  $0.201893. Earlier default-effort attempts timed out without activation; their
  receipts are retained. The basic authentication/transport diagnostic succeeded.
  The exact stall cause is unproven, so this is not presented as a diagnosed
  provider bug or guaranteed latency fix.
- Application typecheck, build and all 147 tests pass. A fresh browser tab connected
  to the existing running Doom session with no captured console errors and no
  document overflow at 1230 x 837. Its game clock advanced and the current guide
  and cumulative stats remained visible. This was read-only browser verification,
  not a reset, checkpoint restore, interactive-control or gameplay-quality test.
- Remaining scope includes live Doom revision activation, broader independent
  improvement evaluation, optional Exo integration and the final full requirements
  audit. The toy acceptance positions establish the autonomous integration path,
  not broadly stronger chess/Doom play.

Doom learning binding and real-runtime qualification:

- `Session` can now bind to the shared revision controller. It applies sparse user
  overrides after artifact policy, pins model/executable provenance for decisions
  and every child, and fences publication against gameplay and guide/control edits.
  The controller remains the only active-pointer authority.
- Supervised application sessions use format 2. Ordinary sessions still use format
  1. Tests execute the actual baseline `fd777f7` reader and prove a clean refusal
  of format 2, while the original saved-session/replay fixture still reconnects
  through the extracted core. Explicit adoption preserves existing state/controls;
  a lost adoption acknowledgment requires authoritative reopen.
- `DoomExecutableModel` sends observed state, stats, geometry feedback, user guide,
  skills and resolved policy into isolated source execution. It accepts only a
  complete distribution over host-owned feasible actions or plans. Unknown actions,
  extra commands/scores and inconsistent choices are refused after retaining the
  execution receipt and charging the invocation.
- `npm run qualify:doom-revisions` passed in three separate processes with real
  game VMs and real source-execution VMs. Evidence:
  `artifacts/doom-revision-qualification/2026-09-18T05-33-02.478Z`. Controlled wait/
  advance programs used identical 14-tick budgets and one executor call each.
  Host-measured displacement/damage scores were 0 and 38.388842 respectively.
- The accepted executable continued after restart. Learning rollback and world
  rollback restored the old revision and exact checkpoint state/frame, then another
  process resumed at epoch 2. Selected replay ancestry and user overrides survived.
  All live futures plus bootstrap consumed exactly 77 ticks; evaluation consumed
  another 28. Five source VMs were released. A complete provider inventory verified
  no owned game VMs, source VMs or checkpoints remained; cleanup queues were empty.
- The application checks pass with 157 tests, typecheck and build. The standalone
  package is unchanged at `2fdab29` (97 checks/tests previously verified).
- The Doom server entrypoint has not enabled the new binding or switched the user's
  running session. Journal ownership, proposal-generation/status commands, UI
  integration and broader Doom learning evaluation remain. This controlled test
  proves the real-runtime integration, not autonomous Doom improvement.
  See `apps/server/DOOM-LEARNING.md` for the integration contract and limitations.

Doom server owner and artifact-aware Jev integration:

- `DoomSupervisor` owns a durable controller journal with explicit legacy adoption,
  verified binding on restart, generation-origin checks, evaluation/activation/
  rollback methods, and joined shutdown. It does not independently choose an
  evaluator or acquire a cross-process storage lock; those belong to server wiring.
- `DoomLearningModels` verifies artifact hashes and supported adapter/executor/model
  pairings. Built-in Jev consumes bounded revision prompts and skills without
  replacing the user guide, stats, skills or host-owned action/plan candidates.
  Stored executable artifacts remain dispatched exclusively through the isolated
  model factory. Unknown prompt slots and ABI mismatches fail before use.
- 167 application/example tests passed, with typecheck and production build.
  Ten added tests cover baseline request equality, prompt/skill propagation, content
  validation, explicit adoption, journal restart/rollback, lost publication replies,
  stale user context, interrupted evaluation and joined cancellation/adoption.
- Two real Jev requests passed in action and plan modes: 4415 input / 215 output
  tokens, evidence `artifacts/doom-jev-revisions/2026-09-18T05-55-04.355Z`.
  These used local WASM observations, not VMs or a gameplay-quality evaluation.
- The live server remains on its existing unbound session. `main.ts` ownership and
  lifecycle wiring, proposal generation/review UI, autonomous Doom evaluation and
  the full requirement audit are still pending. The current source ABI ranks
  host-owned candidates; replacing candidate-generation/game-adapter code is not
  yet supported by the live Doom adapter.

Doom proposal generation and bounded real-provider qualification:

- Added credential-free observed-evidence capture, strict guidance/source proposal
  schemas, immutable request/source records, durable per-job status and metered
  provider dispatch. The existing outer-provider port remains replaceable.
- Generation captures baseline epoch and user-context identity before the model
  call. Only a validated proposal may be submitted; generation cannot evaluate or
  activate it. User guide changes, unknown prompt fields, unsupported ABIs, invalid
  source and spending overruns prevent submission while retaining evidence.
- Jobs reconcile committed submissions after lost acknowledgments and never
  silently call the model again. Interrupted jobs remain interrupted. The host
  still needs the server job manager, exclusive storage ownership and API/UI wiring.
- Eight new tests cover generation, source retention, duplicate dispatch, stale
  context, invalid outputs, budgets/cancellation, restart reconciliation and
  evidence filtering. The full application/example suite passes 175 tests.
- Real qualification: `artifacts/doom-supervisor-proposal/2026-09-18T06-09-43.586Z`.
  Two real Jev requests produced four trial futures in local Doom WASM, using 385
  total ticks including child initialization/reconstruction. One Claude invocation
  returned a valid guidance/policy proposal in 30.463 seconds at reported cost
  $0.15003. The host submitted it for review, kept epoch 0, and reopened the job
  without another provider call. These are not VM or stronger-gameplay results.
- Independent evaluation of this actual generated Doom proposal, server/UI wiring,
  broader game-learning capability and the final requirement audit remain pending.

Independent Doom evaluation and supervisor feedback:

- Added `qualifyDoomRevision`, using the real application session loop for both
  artifacts with frozen host scenarios, equal total budgets, user guide/skills and
  sparse overrides. Runtime/model/cleanup ports are separate from the proposal.
  Unsupported recovery settings fail explicitly; startup, storage, cancellation
  and cleanup errors cannot qualify a candidate.
- The generated Claude proposal was evaluated unchanged across three different
  first-map starts: gains +99, -20 and -1, mean +26. The fixed no-regression rule
  rejected it, and the evaluation controller stayed at epoch 0. Evidence:
  `artifacts/doom-revision-evaluation/2026-09-18T06-22-13.962Z`.
- All six real local-WASM/Jev runs completed: 3024 charged ticks, 72 model calls,
  158276 input and 7314 output tokens. These are short scenario results, not broad
  Doom competence, VM-fork performance or a statistically conclusive benchmark.
  The original proposal and live session journals were not modified.
- Later generation requests now include bounded summaries of prior qualified or
  rejected proposals and aggregate feedback, excluding private acceptance states,
  case IDs and diagnostic prose. Unit tests verify that this feedback is retained
  while the original baseline remains active.
- Production runtime ownership and supervisor/evaluator API/UI wiring remain, as
  do broader learning/code-adapter capabilities and the final requirement audit.

Background jobs and server store ownership:

- Added a durable one-job owner for proposal generation and independent evaluation.
  Admission is asynchronous and idempotent by client UUID. Cancellation retains the
  slot until provider/evaluator cleanup completes; shutdown joins it before the
  supervisor is closed. Restart recovers committed results or reports interrupted
  work without constructing the provider or repeating a paid request.
- Job completion and acceptance are separate: an evaluation can finish normally
  and reject the candidate. The active revision remains controller-owned.
- The real server now reserves HTTP and a canonical-data-directory local process
  lease before opening stores. The lease survives browser disconnects and is
  released by the kernel on process death. `MOM_DATA_DIR` isolates session,
  recordings, VM settings and movie exports for separate instances.
- Focused tests cover shutdown/cleanup races, lost acknowledgments, restart,
  duplicate requests, resource-recovery failures, symlinks and hard process death.
  Duplicate startup against the real occupied HTTP port was refused; the existing
  live game was not restarted. Production evaluator composition, review UI, broader
  mutable learning components and the complete requirement audit remain pending.

Production VM evaluator composition:

- Added `DoomVmEvaluations`, which freezes each proposal's evaluation manifest and
  joins the existing paired evaluator, real VM runtime, normal Session decisions,
  checkpoint recovery, per-run budgets and durable evidence. Contract/context
  mismatches are refused before dispatch, and an admitted experiment cannot rerun.
- Added physical-resource ownership for root creation, forks, full snapshots and
  restores. Cleanup joins dispatched work and survives lost acknowledgments and
  process exits. Initialization/setup/all future inputs are charged; VM memory
  forks and restores perform no unmetered input replay. Failed cleanup prevents
  the next run from allocating resources.
- Live qualification caught and fixed two integration assumptions: full restore
  does not inherit labels, and the shared collector reports deleted references.
  Recovery verifies exact acknowledged identities or recorded parent-snapshot
  provenance for unacknowledged restores/forks. It does not restart VMs to relabel
  them or force snapshot deletion. Failed qualification resources were released.
- `artifacts/doom-evaluation-vms/2026-09-18T07-06-01.982Z` verifies actual state/PNG
  equality after fork/restore, 63 ticks, and separate-process cleanup of all VMs and
  checkpoints, including a deliberately unacknowledged restored-world fork.
- `artifacts/doom-vm-evaluation/2026-09-18T07-03-11.122Z` verifies the composed loop
  with real Jev: four calls, 140 ticks, ten game VMs, two completed paired runs and
  automatic checkpoints, all cleaned and verified absent. The prompt candidate
  was rejected for no measured gain. No live activation or broad quality claim.
- Server service/provider/budget composition and API/UI remain, along with broader
  mutable learning components and the final scope audit.

Application learning service and review:

- Composed the production provider, evaluator, executable runtime, budgets and
  durable job manager in `DoomLearningService`, with opt-in legacy adoption.
- Added API commands and the header's Learning lab modal for proposal generation,
  independent evaluation, source/result review, cancellation, activation and
  rollback. Activation remains a paused-boundary operation; jobs are asynchronous.
- Frozen build/image/evaluation/budget manifests prevent silent changes underneath
  an active supervised game. Source/assets are retained at enablement. Existing
  legacy games remain unbound until explicitly enabled.
- Service integration tests exercise six paired fixture runs, no-repeat spending
  across restart, rejected activation, unchanged live state, cleanup, stale guide
  handling and build identity refusal. Broader mutable candidate/context/curriculum
  code and the complete requirement audit remain outstanding.

- The integrated review workflow is now served on localhost:4317 with the legacy
  game left unbound. A real proposal initially exposed insufficient gameplay
  coverage; the corrected contract requires six seconds of selected play per
  nonterminal run. The regression test prevents accepting unfinished futures.
- Corrected real service evidence is in
  `artifacts/doom-learning-service/2026-09-18-coverage-gate`: a Claude prompt/skill
  proposal gained +45/+13/+11 across three paired starts, followed by browser
  activation, server restart, duplicate-request accounting and browser rollback.
  All 117 experimental VMs and owned checkpoints were verified removed. This is
  a small contract-specific result, not broad gameplay proficiency.
- The app suite passes 203 tests, type checking and production build. The live
  handoff preserved five active worlds and 848 recording entries. The broader
  editable candidate/context/curriculum components remain the next substantive
  implementation work; the original goal is not complete.

Editable preparation stage:

- Added a reusable typed `executeLearningStage` core function with frozen inputs,
  metering, raw receipts and host validation. Core checks now pass 100 tests.
- Added Doom's `prepared-doom-jev` interface: isolated source generates bounded
  candidate plans, selects retained attempts/history, and creates derived context
  before Jev decides. Existing ranker artifacts keep their original interface.
- Added supervisor planner proposals and production model dispatch. Stats, guide,
  user controls, motor safety, outcome scoring and budgets remain host-owned.
  The actual selected memories and preparation provenance reach session evidence.
- Real proof at `artifacts/doom-prepared-model/2026-09-18T07-55-51.350Z`: newly
  generated routes, real Jev selection, two exact game futures, promotion and
  verified cleanup, charging 105 ticks / one executor / one model call. Source
  was diagnostic and hand-authored; this does not claim autonomous improvement.
- App checks pass 209 tests. Autonomous preparation-code evaluation, editable
  execution/outcome shaping/curriculum and the full requirement audit remain.


Proposal focus and live failure recovery:

- Requests can now require guidance, planning/memory code, or decision code.
  Focus survives durable job replay and is enforced against the returned draft;
  changing focus under an existing id cannot cause another paid call.
- The first real planner proposal (`2026-09-18T08-05-58.789Z`) exposed an input
  contract ambiguity: it assumed the summarized evidence shape was the raw engine
  ABI. No source was activated. The proposal request now includes a bounded example
  built by the runtime input builder plus the actual output schema.
- A live all-dead-futures batch exposed a separate adapter error when checkpoint
  recovery was off. The adapter now rejects it, preserves the living source and
  pauses for review, keeping failed attempts in history. With recovery enabled,
  configured retries and rollback continue to apply.
- The real-session handoff at
  `artifacts/learning-service-handoff/2026-09-18-preparation` preserved every active
  game state and all 55 then-current recording entries (438573758 retained bytes).
  The completed dead futures were then archived without advancing the main game;
  source state equality was checked after recovery. Learning remains off.
- App tests reached 211 passes before the input-builder extraction; the subsequent
  focused provider/model/service tests and type checking also pass. This does not
  establish autonomous gameplay improvement or complete the broader scope.


Autonomous preparation source, component qualification:

- Claude generated the planner in
  `artifacts/doom-supervisor-proposal/2026-09-18T08-10-05.665Z` from observed play,
  the shared ABI example and return schema. Reported cost was $0.548289 and
  generation took 128.337 seconds under the diagnostic $2/300-second limits;
  this exceeds the current UI's $0.50/120-second per-proposal defaults.
- Its first real execution correctly failed strict validation because it copied
  host-only `evidence`/`novelty` metadata from default plans. The host input builder
  now exposes defaults in the editable output shape, with per-invocation step
  limits. Output validation remains strict and host novelty remains independently
  calculated. A regression test proves default plans can be reused at a short
  horizon. No generated source was edited.
- The unchanged generated source then passed
  `artifacts/doom-prepared-model/2026-09-18T08-14-00.562Z`: one isolated code call,
  one real Jev call, two exact Doom futures, 105 charged ticks, winner promotion,
  and verified removal of all owned VMs. This uses explicit diagnostic timing/
  breadth overrides and the current host build; it is not an independent quality
  comparison or a live revision activation. Broader scope remains unfinished.


Generated planner comparison and mutable search scoring:

- `scripts/evaluation/doom-planner.ts` runs unchanged generated source against the
  built-in Jev model with the same explicitly recorded planning profile, fixed
  simulation/model/executor allowances, private first-map starts and independent
  acceptance metric. It rebinds both artifacts to the current qualified host;
  this is a fresh comparison, not the original proposal's diagnostic contract.
- Real result: `artifacts/doom-planner-evaluation/2026-09-18T08-17-10.888Z`.
  Baseline completed all three starts. Candidate failed coverage on start 0,
  exhausted its no-time-progress guard on start 1, and scored 10286 against 10492
  on start 2. Rejected. There were 362 real model requests and 170 preparation
  receipts; 82 game VMs and 171 executor VM records were verified cleaned up.
  No generated revision was activated in the live app.
- Added optional bounded per-priority `policy.outcomeWeights`. It changes search
  scoring while the independent acceptance function remains host-owned. The
  opening decision's policy reference pins scores for every sibling. Tests cover
  changed selection, restart, tamper refusal and unchanged independent metrics.
- `artifacts/doom-outcome-compatibility/2026-09-18/verification.json` verifies all
  201 then-current legacy policy records unchanged and clean refusal of shaped
  records by the actual prior reader retained with the earlier experiment.
- Real shaping/component proof:
  `artifacts/doom-prepared-model/2026-09-18T08-24-16.580Z`. One actual isolated code
  call, one Jev call, two Doom futures, exact policy-derived scores and winner
  promotion, 105 ticks and verified resource cleanup. Not a quality claim.
- All 215 app tests passed after scoring integration, along with type checking,
  build and diff checks. The subsequent failure-feedback change passed 12 focused
  provider tests and type checking. The live backend remains on its prior loaded
  build while the user plays; source changes must be loaded at a safe pause.
- Editable motor execution and curriculum components, autonomous improvement
  iteration and the full original requirement audit remain unfinished.
