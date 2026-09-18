# Completion checklist

Current assessment: 2026-09-18. This is the current completion tracker; dated
qualification notes in the other design documents describe historical milestones,
not current completion. Unchecked means unfinished or insufficiently verified.

The target is a reusable TypeScript game-learning engine: game-specific adapters
expose observations and legal controls; an occasional supervisor creates and
improves reusable strategies/code; Jev handles frequent decisions; Microsandbox
provides real forks and checkpoints where supported. The Doom application must
use that engine, remain understandable to viewers and preserve session history.
This is strategy/system learning, not demonstrated model-weight training.

## Foundations already present

- [x] Separate TypeScript harness directory with generic lifecycle, trial,
  learning-loop, revision, policy, persistence and replay components.
- [x] Doom integration with real detached sandboxes, branching, complete-world
  winner promotion, checkpoint recovery, selected replay ancestry and cleanup.
- [x] Replaceable decision model and Codex/Claude supervisor providers; supervisor
  CLI generation bypasses permissions without harness spending caps.
- [x] Versioned policy/prompt/skill, isolated ranking-code and preparation-code
  proposals, independent comparisons, rejection and revision rollback machinery.
- [x] Development implementation of automatic background observation and
  propose/test/apply coordination, with persisted deduplication and cooldown.
- [x] Development UI removes the manual Learning lab and spending panels; status,
  pause and provider selection remain. Typecheck/build and 81 focused tests
  passed; settings were checked in a browser using a recorded-state fixture.

These checks establish components, not autonomous improvement or full completion.

## 1. Preserve the existing run through rollout

- [x] Finish explicit gameplay-build upgrade and learning-lineage handoff.
  Historical artifacts remain immutable and verifiable; new decisions identify
  the new build. Preserve sandbox identities, stats, objective, overrides,
  checkpoints, memory and recording ancestry.
- [x] Test interrupted upgrades, restart, tampering, rejection of active
  comparisons and recovery to an authoritative state.
- [x] Serve the demo and automatic workflow on localhost:4320. Older backends
  on 4317/4318 are stopped; the original data remains preserved.

The explicit offline upgrade publisher now exists (`scripts/upgrade-gameplay-build.ts`).
Its fixture handoff test passes, and the live cadence rollout preserved the main
VM state, cumulative stats, checkpoint list and recording history. It creates a
new baseline and read-only historical lineage; it does not substitute stored
build hashes. Additional service tests cover a failed source-retention step,
SIGKILL after preparing a complete lineage but before publishing the session,
lease reacquisition, reopening the old binding, publishing/reopening the new
binding, repeated-build no-op, unresolved comparisons, interrupted evaluations
and tampered archived history. Original journals and the selected checkpoint stay
unchanged on refusal. These are process-interruption and fixture-runtime checks;
the earlier live handoffs separately verify preserved physical game state. They
do not establish power-loss durability. Evidence:
`artifacts/upgrade-recovery/2026-09-18/`.

Abandoned upgrade cleanup is now implemented for newly marked preparations.
Server startup and offline upgrade maintenance collect owned staging work and
unchanged unpublished lineages under the data lease. Current sessions, rollback
backups and embedded history protect published builds; changed or unmarked
directories remain untouched. Six focused upgrade tests and a follow-up three-case
run cover these checks, including garbage collection after an actual SIGKILL.
Type checking passed. The startup hook was loaded during the combat/intermission
maintenance restart. Older unmarked orphan
directories need separate reconciliation. Evidence:
`artifacts/upgrade-cleanup/2026-09-18/`.

Combat/intermission qualification: ranged plans now share the motor's height
eligibility and do not approach across a height difference before firing. In an
isolated real-VM opening comparison, the offered attack produced one kill and
100 health versus exploration's zero kills and 85 health. Scripted choices isolate
execution; this is not a Jev quality or historical-policy benchmark. The results
screen now receives bounded button press/release inputs without model calls or
forks, and trials stop on level completion. A fork of the actual stuck intermission
advanced E1M1 to E1M2 in 30 ticks while preserving its source. The live upgrade
preserved the selected world and stats, then advanced it to E1M2 and left it paused
with six cumulative kills and 97 health. All test VMs were removed. 378 application,
120 harness and four web tests passed, along with typecheck, production build and
the harness's clean external-package consumer. Evidence:
`artifacts/combat-diagnostic/2026-09-18/`. Broader combat strength remains unproven.

## 2. Make strategies adaptable, including a new game's first strategy

- [x] Define a supervisor-consumable adapter description covering observation
  meanings, legal controls, timing, objectives/outcomes and available capabilities.
  The public `GameDescription` format and validator are wired into chess source
  proposals. Runtime-backed tests verify chess field/control/clock/outcome semantics;
  a recording-provider test verifies request evidence, adapter mismatch rejection
  and source-only publication. This does not establish autonomous strategy bootstrap.
- [x] Bootstrap a reusable strategy and candidate generator from that contract.
  Codex generated chess preparation source from the mechanics description and a
  generic pass-through baseline, without training traces or a supplied opening
  strategy. The unchanged output ran in six real isolated VMs before Jev selected
  moves; it produced annotated legal menus/guidance through two comparisons and
  four main-path plies. Reconnect, selected replay and exact VM cleanup verified
  against the same run after correcting a JSON/undefined assertion. Evidence:
  `artifacts/chess-strategy/2026-09-18T14-47-54.005Z`. This establishes bootstrap
  mechanics, not chess strength, useful pruning or automatic browser supervision.
- [ ] Automatically add, replace and remove strategies based on evidence of
  missing options, repeated failures and obsolete conditions. Generated candidates
  must stay grounded in observations and pass host validation.
- [ ] Make temporary subgoals explicit, persistent, scoped and expiring, without
  overwriting the user's objective. Report missing observations/controls as gaps.

Doom still has hand-written seed strategies. Generated planner `19db5d37-f130-4285-85dc-a6fe7c68f8a3`
qualified on three opening cases (mean gain 45.67) and activated automatically.
That establishes a working replacement path, not robust gameplay or recovery
from the currently stuck room.

## 3. Finish the supervisor's supported improvement surface

- [ ] Make plan execution/motor behavior and remaining strategic thresholds
  configurable or replaceable through versioned artifacts, with host validation.
- [ ] Implement training-scenario/curriculum selection while keeping independent
  acceptance scenarios outside supervisor control.
- [ ] Verify each promised mutable component end to end: guide additions, skills,
  context/memory selection, candidate generation, execution, scoring weights,
  fork threshold, breadth, duration, interruption and recovery policy.

Some of these already exist individually. The unchecked item requires the full
inventory and supervisor-driven use, not just exposed configuration fields.
User instructions and explicitly pinned settings remain authoritative. Canonical
history, VM identities, resource ownership and acceptance evidence are not mutable.

## 4. Prove that automatic learning helps during real play

- [x] Capture the live problem at a safe boundary, freeze proposal evidence, and
  evaluate both strategies from that physical checkpoint with inherited history.
  Require improvement there and retain the opening cases as non-regression checks.
  Fixture service/restart tests and a four-run real-VM lifecycle smoke pass. Deployed
  on 4320 without changing the saved world states or cumulative stats. The automatic
  supervisor captured proposal `b06d586c-b5b6-4912-992d-4abed90234bb` after rollout.
  The first two live comparisons completed and rejected changes with zero
  improvement at the saved position; successful room recovery remains unproven.
  Follow-up tests cover early rejection, shared future ceilings, incident feedback,
  and verified historical feedback across upgrades.

- [ ] Demonstrate a full unattended real-game cycle: detect a persistent problem,
  create an appropriate change, compare independently, activate a qualified
  improvement at a natural boundary and continue the same run.
- [ ] Demonstrate rejecting a bad change and rolling back a regression without
  losing history; restart during the cycle without duplicate paid requests.
- [ ] Measure progress, survival, kills/score or completion on held-out scenarios,
  comparing supervision on/off with matched simulation/model allowances.
- [ ] Measure supervisor tokens and latency; verify that healthy/repeated unchanged
  situations do not trigger needless calls. Keep accounting diagnostic, not a
  user-managed token-budget workflow.

Real background proposals have been rejected and activated. The accepted planner
and a later guide update demonstrate automatic publication, but opening-scenario
scores do not establish recovery from a later encounter. High Jev confidence is
not the success criterion.

Chess now has a separate full-harness paired evaluator that measures actual
forks, discarded inputs and selected-path promotion under matched allowances.
The real 12-run check at `artifacts/chess-strategy-evaluation/2026-09-18T18-21-14.994Z`
rejected the current learned source: opening gains +1/-2/-4 could not be offset by
queen-pawn gains +17/+18/+11. All 143 preparation VMs were removed. This is useful
qualification evidence, not completed gameplay-strength work. New automatic
reviews and regression audits now use the full evaluator through frozen format-4
contracts; formats 1–3 preserve their original meaning. A real 12-run controller
qualification at `artifacts/chess-strategy-evaluation/2026-09-18T18-31-01.118Z`
persisted a rejection, reconnected without redispatch, and removed all 144 VMs.
The rollout preserved both live sessions and all existing learning journals.

## 5. Demonstrate reuse with another existing game

- [x] Run a pre-existing non-Doom game through the same observe/plan/Jev/execute/
  learn/replay interfaces, including supervisor strategy bootstrap and revision.
- [x] Demonstrate ordinary ongoing play, not only a hand-crafted tactical puzzle.
- [ ] Finish application-level game/session selection and persist settings,
  learning history and replays independently per game/session.
- [ ] Document adapter requirements and unsupported capabilities. A game without
  exact snapshots must not be presented as having exact sandbox forks.

Chess now uses those interfaces with real Jev, alternative boards, winner promotion,
checkpoint restore and selected-path replay. The ordinary run on 4321 reached 38
plies from the initial board; the separate learning run on 4322 bootstrapped a
Codex-generated strategy, rejected one proposal, activated another and continued
the same history to eight plies. The shared menu switches between existing sessions.
These establish integration and ordinary play, not playing strength. Shared session
creation and explicit migration of historical plain sessions remain unfinished.
Doodle Shooter is a candidate, not an already working or source-accessible adapter.

## 6. Resolve performance and sustained-operation concerns

- [x] Implement owned background loser cleanup for automatic promotion. The winner
  advances during cleanup; pause, rollback and the next fork join it. Harness
  checks (109 tests), seven session lifecycle tests and a real three-VM Doom
  continuation smoke passed. Deployed on localhost:4320 with exact world-state and
  cumulative-stat preservation across restart; observed two subsequent live
  promotions and 420 selected game ticks without a session error.
- [x] Prepare the next Jev decision during conditional-plan execution, with
  state/instruction/revision checks and joined cancellation. Real Doom/Jev smoke
  reused 5 of 14 judgments, four with under 1 ms blocking wait. Action mode still
  waits for current-state decisions. Deployed; live sampling observed a 622 ms
  request consumed with a 0.5 ms wait. State changes still require fresh decisions.
- [x] Let supervisor policy select future breadth below the user's persistent
  maximum. Tests activate 4, 10 (clamped to 6), then 2 and verify actual fork counts
  plus restart preservation. UI shows the effective target and user cap.

- [ ] Attribute the slowdown with measurements: simulation/render rates, Jev
  latency, snapshot/fork latency, persistence and serialization, concurrent VM load.
- [ ] Apply and verify the required fixes. The redundant snapshot clone has a
  development fix; it is not proof that the observed frame-rate problem is solved.
- [ ] Soak-test gameplay plus background evaluation: no orphan VMs/executors,
  bounded live resource use, retryable cleanup after failure/cancellation/restart,
  safe snapshot deletion and periodic layer compaction.
- [ ] Verify recording/state GC preserves selected ancestry and referenced
  checkpoints while reclaiming disposable data. Selected full-session recordings
  remain until explicit user reset/deletion, not silent retention expiry.

## 7. Complete the viewer and replay experience

- [ ] Verify the deployed UI clearly shows main vs experimental vs archived worlds,
  live play vs replay, current control owner and supervisor status.
- [ ] Verify supervision works without manual proposal/test/activation controls and
  applied changes appear as concise commentary.
- [ ] Complete continuous recordings/replay for supervisor comparison runs;
  Doom still has sampled previews rather than full gameplay video. Chess now
  exposes selected-path board replay, play/pause/seeking and position selection,
  plus live trial previews. Real saved audit playback and responsive layouts
  were checked; live preview delivery has controlled-session tests. The latest
  comparison is viewable, with historical receipts retained on disk.
- [ ] Recheck selected-future stitching, playback to a chosen point, restart,
  backtracking, archived-world inspection and refresh continuity after upgrades.
- [ ] Recheck flicker, unwanted winner-view interruptions and avoidable pauses on
  the integrated live build. A UI fixture cannot prove these runtime properties.

## 8. Finish the reusable deliverable

- [ ] Audit remaining game/provider/runtime assumptions and keep mechanics in
  adapters, orchestration in the harness, and executables isolated from the host.
- [x] Finish the independently usable harness package in the single repository and
  verify a clean install/build/test plus documented game-adapter onboarding.
- [ ] Consolidate stale milestone prose into current architecture, run instructions,
  supported behavior and limitations. Keep exact qualification evidence linked.
- [ ] Run the final application/core checks and the required real-runtime and
  cross-game acceptance scenarios. Report failures and unverified claims plainly.

Standalone package qualification (2026-09-18): `harness/npm run check:package`
now builds from a clean source snapshot, runs all 120 core tests, packs compiled
ESM/declarations, installs the tarball in an external consumer, typechecks with
library checking enabled, and executes public routing/trials/durable storage.
`harness/ADAPTERS.md` documents the mechanics/host boundary, capabilities,
cancellation, persistence, learning and qualification requirements. This passed
on Node 26.3.1 without using the app's node_modules. By user direction, delivery
is now one repository: `harness/` is a normal tracked npm workspace, the concrete
executor and supervisor providers live in `packages/`, and Doom and chess are
peers under `examples/`. A clean checkout passed a single root `npm ci`, typecheck,
production build and web tests. Download/setup and a real three-VM Doom fork smoke
passed; the chess launch command served its paused fixture and browser assets.
The application and harness suites passed 378 and 120 tests respectively. The root
README documents `demo:doom` and `demo:chess`; detailed guides live with each example.
Evidence: `artifacts/harness-package/2026-09-18/`.

Completion requires the unchecked items above, not a fixed number of passing
unit tests. Release, publication and commits still require explicit authorization.

## Current situation recovery work (2026-09-18)

- [x] Conditional-plan decision intervals and backend-persisted comparison-duration
  linking are live. Verified with a real five-future trial at a two-second deadline.
- [x] Implement planner escalation for stalled conditional play and bounded repeat
  reviews after fresh selected gameplay. Eight focused tests pass. This escalation
  change is loaded in the running server.
- [x] Evaluator can restore paired trials from a host-pinned incident snapshot,
  verify its physical identity and exact engine state, and retain the borrowed
  source while cleaning trial VMs. Nineteen focused tests and typecheck pass.
  Real smoke (`scripts/incident-restore-smoke.ts`) restored tick 1101 twice,
  forked each root, metered 14 new ticks, removed four VMs and retained the source.
- [x] Automatically capture the *current problematic situation* at a safe gameplay
  boundary, durably associate it with the supervisor request and retain it through
  cancellation/restart until evaluation descendants are cleaned.
- [x] Require measured improvement on that frozen incident as well as general
  regression checks before applying a recovery change. Real restored-VM smoke and
  live paired tests verify the gate. Proposal `204b4ba4-fc0a-4f60-b05a-39095e22b7d8`
  gained one incident cell and passed all three opening pairs; it activated
  automatically. This small gain is not proof of escaping the room.
- [ ] Verify an unattended escape/combat recovery from the actual stuck room and
  expose the observed failure, tested alternatives and result clearly in the UI.

- [x] Right-sidebar collapsible available-plans panel shows the focused world's actual
  last decision menu, selected option, plan steps, added/removed/updated options,
  with active and previous learned guidance grouped under Guide the AI alongside the user goal. Proposed
  changes are separately labelled. Plans, performance and checkpoints share one card. Verified on live localhost:4320 in the browser;
  main page retains viewport height and sidebar scroll. Two-column viewing shows four futures with optional auto-scroll; settings use a wider responsive panel. Session/observer tests: 58 passed.
- [x] Deploy the tested automatic goal-change review trigger. Observer tests and service restart/provider evidence pass; loaded on localhost:4320 with the live usage fix.
- [x] Remove lifetime live planner/Jev call caps while preserving the original usage journal. Real gameplay continued beyond 1,038 executor calls after the old 1,000 limit; all world states and cumulative stats matched across restart.

- [x] Diagnose the current-room interaction failure in restored real VMs. Recovery
  steering was overriding the next face/use step after arrival; the host use-range
  check was also shorter than the engine range. Corrected production Session
  activated the switch from the identical checkpoint after 127 ticks. Mechanical
  regression tests pass; unattended room escape remains unchecked above.

Performance investigation (2026-09-18): the read-only live observer measured normal
exploration delivery at a 36 ms median, decision waits around 656 ms, and phase
transition gaps up to 3.54 seconds while background evaluation was active. An
isolated Jev smoke reused 3 of 12 decisions; early plan completion and changed
height prevented some prefetch reuse. Current learned-executor receipts showed
458 ms median invocation time in a 100-receipt sample. A separate real-VM benchmark
measured 324 ms fresh versus 213 ms clean-snapshot invocation medians (three runs
each), with fresh per-invocation marker state and complete cleanup. This is
attribution evidence; production prewarming and sustained performance qualification
remain open.

Further performance evidence (2026-09-18): the production executor now journals
optional phase timings. Interleaved real-VM mechanical runs measured 348 ms median
sequentially (174 ms creation, 5 ms upload, 110 ms execution, 58 ms cleanup) and
394 ms with four concurrent calls. All 15 load-test VMs were removed; the existing
real isolation/output-limit/timeout/cancellation smoke also passed. Startup is
the largest measured component; clean reserve/template lifecycle work remains.

Deployed opt-in session patches omit unchanged commentary and other sidebar
fields, preserve old stream clients, and keep the browser's stream cursor separate
from command replies. Overlapping 35-second live probes measured 35.8% fewer
bytes per update (36,952 vs 57,546), without observer errors. Refreshed browser
connected and displayed advancing frames with no captured console errors.
Selected state, preferences, stats and checkpoints matched across deployment.
Evidence: `artifacts/live-performance/2026-09-18/stream-patches/`. This establishes
payload reduction, not completion of frame-rate or sustained-operation work.
The gameplay sample finished with automatic recovery to a paused, healthy main
world (health 101), no remaining experiments, and background learning enabled.
It also exposed a separate proposal failure: the shortened guidance-only task
uses `taskParts.slice(0, 4)`, omitting the fifth entry's built-in Jev prompt/skill
limits. The live proposal exceeded the 1024-character guide limit and was rejected.
The request contract now shares explicit common instructions (no positional
slice) and derives guidance/planner output fields from the Jev validator. Tests
cover the advertised schema, exact 1024/1025-character boundary, aggregate UTF-8
validation and restart without another generation call. This repairs the omitted
constraints; it does not guarantee that every generated change improves play.
Deployed and verified with a real Codex guidance request: proposal
`ffd43a25-a2f8-462f-9a8d-8adf4ad26eff` returned a 1,013-character guide and passed
submission validation (22.1 seconds, reported 30,533 input / 563 output tokens).
Its paired saved-position evaluation then correctly rejected incomplete coverage:
both sides exhausted 4,200 total simulation ticks before any of four 2,100-tick
futures completed. This exposes an evaluation-allowance mismatch with the user's
60-second trial setting. The next fix must preserve equal allowances, selected
gameplay coverage and private acceptance criteria while supporting the configured
trial duration; do not count partial futures as improvement. Remaining six runs
were skipped, all 12 evaluation/executor VMs and two recovery snapshots were
verified absent, and background learning was re-enabled. Evidence:
`artifacts/guidance-contract/2026-09-18/`.
The deployment itself preserved the selected world exactly. A subsequent New game
event at 1789761120303 changed the live session before the manual qualification
started; that comparison used its already-frozen pre-reset incident. Final state
is a fresh paused game at health 100. Therefore the before/after evaluation files
must not be interpreted as proving unchanged live state across the whole test.

Long-trial evaluation allowance (2026-09-18): new learning lineages opt into a
versioned host rule that sizes one shared allowance from both policies, user
overrides, trial duration, decision cadence and the permitted future count.
Historical fixed contracts remain unchanged. Selected-gameplay coverage and
private acceptance criteria are unchanged; partial futures still do not qualify.
A real-VM test completed four 60-second futures per side, committed at least 60
seconds per side under the shared 8,435-tick allowance, and verified removal of
all 18 VMs. Deterministic judgments make this lifecycle evidence, not evidence
that Jev or a supervisor revision improves gameplay. Evidence:
`artifacts/evaluation-allowance/2026-09-18/`.
Deployed to the live Doom host after 30 focused tests and type checking passed.
The restart preserved the selected world (health 106), run statistics, configured
timing and future limits, skills, saved recovery state and persistent experience.
Background learning is enabled and the game remains paused as before maintenance.
The transient display of experience used by the previous decision clears on
restart; the stored attempts themselves were compared and remain unchanged.

Real Jev follow-up `6618ec37-607d-4834-bde5-604c51dab349`: baseline committed
60 seconds from the incident, finishing at health 98; candidate failed selected
coverage (0/210 ticks). Remaining regression cases were skipped, and all 18
evaluation VMs were verified absent. The job also became stale after the live
user context changed. No revision was activated. Evidence:
`artifacts/long-trial-jev/2026-09-18/`. Recovery rejected the first completed batch
for losing at least 30 health, then its retry exhausted the shared allowance.
Do not infer improvement from the allowance fix.
The proposal exposed incorrect supervisor timing evidence: its summary defaulted
to one-second actions despite a trial-linked 60-second interval, and its planner
example used the inactive fixed interval. The source correction supplies current
effective timing to both, keeps historical traces intact, and passes type checking
plus 19 focused tests. It is now deployed, with the live checkpoint projection
verified at 60 seconds. A new paid generation has not been requested solely for
verification. Evidence: `artifacts/supervisor-timing/2026-09-18/` and
`artifacts/failed-evaluation-feedback/2026-09-18/restart.json`.

Failed coverage diagnostics (2026-09-18): retain observed session/decision evidence
in failed run records and comparison reports, without scoring or accepting the
failed run. Public incident feedback distinguishes committed time from trial work
and includes rejected batches, retries, deaths and recovery's explanation. Private
regression observations remain excluded. This fixes the missing feedback that
made a rejected batch look indistinguishable from gameplay that never executed.
Type checking and 46 focused tests passed. A deliberately undersized real-VM
comparison retained partial observations, remained rejected with no metrics, and
removed all 10 VMs. Deployed while preserving the current paused game, objective,
settings, recovery and persistent experience; background learning is enabled.
Evidence: `artifacts/failed-evaluation-feedback/2026-09-18/`. No new strategy
improvement or room-escape result is established by this diagnostics change.

Chess gray right margin: live browser had a 1296-pixel test viewport inside a
1512-pixel window. Matching the viewport to the window restored full-width content
with no CSS changes. Screenshot and dimensions:
`artifacts/chess-viewport/2026-09-18/`. Future browser sizing checks should restore
the original viewport rather than leave a narrow test viewport in the user's tab.

Paused incident capture (2026-09-18): queued supervisor checkpoints are now
serviced after a manual promotion or recovery rollback ends at a safe paused
boundary. Regression coverage includes the service's checkpoint-preparation
status and generation starting only after capture. A real-VM smoke captured and
exactly restored the paused winner at tick 42 without another Play click; all four
test VMs and its snapshot were removed. Evidence is in
`artifacts/paused-incident/2026-09-18/`. This fixes a stalled-review path, not the
remaining sustained-performance or gameplay-quality requirements.
Deployed on localhost:4320 through the explicit build handoff. Restart comparison
preserved the exact selected state at tick 1295, health 101, objective, gameplay
settings, cumulative stats and recovery checkpoints. The selected replay remains
available with 1,261 frames across three segments and no missing history.

Chess strategy evaluation progress (2026-09-18): paired preparation/Jev evaluation
now uses full saved histories and a frozen baseline opponent. The unchanged Codex
bootstrap gained one additional material point in each of two eight-ply comparisons
(ordinary opening and the position eight plies before the live repetition draw).
All four runs completed; 32 Jev calls and 32 isolated executor VMs were recorded,
and every VM was verified removed. Evidence:
`artifacts/chess-strategy-evaluation/2026-09-18T15-01-18.696Z`. This is short-horizon
single-path evidence, not full-game strength or live autonomous learning. No browser
state was changed. The new durable source-revision connection has measured fixture
coverage for activation, restart, replay provenance, rollback and stale user goals;
37 chess tests and typecheck pass. Per-incident minimum-gain gating has fixture
coverage. Browser observation/scheduling, dynamic incident contracts, learning UI,
and real continuing-session activation remain open.

Chess background coordination progress (2026-09-18): deterministic observation now
captures exact selected-history incidents for repetition, material loss, endings,
bootstrap and changed goals. The new durable job owner and automatic coordinator
freeze evidence before dispatch, deduplicate requests across restart, join cleanup,
and wait for a natural activation boundary. Controlled tests include a lost receipt
after successful proposal submission and verify that no second generation is paid.
43 chess tests pass, plus typecheck. These are component/fixture results; the browser
server still needs dynamic incident contracts, provider/executor wiring, session
migration and visible learning status before automatic chess learning is live.

Chess browser host wiring (2026-09-18): learning-enabled sessions now connect the
Codex CLI, prepared Jev model, dynamic host-pinned incident contracts, durable job
owner, automatic observer and revision controller. Live and evaluation executor
ownership is separate. The UI exposes background status, revision and a joined
on/off control; desktop/mobile checks show no horizontal overflow. Scheduled
play now waits for strategy publication rather than failing on concurrent session
access. Typecheck, web build and 45 chess tests pass.

A separate real qualification is running on port 4322 with data under
`artifacts/chess-automatic/2026-09-18/session`. It automatically requested a Codex
proposal after four selected plies; play advanced to six plies while generation
continued (one comparison 1510 ms, promotion 6 ms). At this checkpoint the actual
Codex process is still running; proposal evaluation/activation and restart are not
yet verified. The original 4321 session has not been modified. Historical-session
migration and unified game/session selection remain open.

Automatic chess cycle qualification (2026-09-18): the port-4322 run finished two
real Codex/Jev review cycles. The first candidate lost two material points relative
to baseline and was rejected. The next candidate gained one point in both pairs,
activated automatically as revision 1, and continued the same selected history to
8 plies. Restart preserved complete session state, enabled preference, active
revision and all 9 replay frames without repeating generation. All 60 executor VMs
were confirmed removed. Evidence:
`artifacts/chess-automatic/2026-09-18/evidence/restart-report.json`.

This is automatic-learning integration evidence. The early incident window and
opening regression both started from the initial board, so distinct held-out
positions, full-game quality and unattended Doom recovery remain unproven. Bootstrap
was costly (319,946 reported input tokens, of which 225,408 cached; 22,409 output).
Verified compact evaluation feedback and a preference for small strategic changes
are now wired into subsequent reviews; token savings are not yet measured. The
updated host is running on 4322. The original 4321 run stays unchanged. Typecheck,
web build and 46 chess tests pass. Unified game/session selection and historical
plain-session transition remain open.

Game/session navigation (2026-09-18): both viewers now share a gamepad menu linking
Doom, original chess and learning chess, with public build-time catalog configuration
for other hosts/ports/session paths. Browser checks navigated among all three,
verified current-session indication, Escape/focus return and a 320 px layout.
Both chess API views remained exactly unchanged, including attempts and learning
state. Doom's narrow-screen toolbar now wraps so pause/audio controls stay visible.
Typecheck, web build and two catalog-boundary tests pass. This completes navigation
between configured existing sessions; shared session creation/management and an
explicit transition for historical plain sessions remain open.

Distinct chess regression cases (2026-09-18): new frozen review inputs use format 2
and require a regression board different from the incident. Both real format-1
inputs still validate unchanged. The reused active strategy passed the incident
pair (+1) but failed the queen-pawn opening (-9); the independent evaluator
rejected it. All 32 real executor VMs were removed. Evidence:
`artifacts/chess-strategy-evaluation/2026-09-18T17-06-03.666Z`.
This does not retroactively change the live activation or prove full-game quality.
Typecheck and 48 chess tests pass. The served UI also fits 320, 390, 768 and 1440 px
without horizontal overflow.

Post-activation chess checks (2026-09-18): an application-owned audit now compares
an active source with its predecessor after adverse gameplay, once per activation
epoch. Legacy format-1 activations receive one distinct-position check. Complete
paired regressions can restore the previous source at a safe boundary; exact
activation/goal checks prevent stale rollback, and incomplete tests retain the
current source. Durable receipts feed compact supervisor feedback and the UI.
Controlled tests cover cancellation, lost acknowledgments, restart, no paid
redispatch and unchanged board/replay during rollback. All 57 chess tests and
120 harness tests pass, with typecheck and web build.

The first real automatic audit retained revision 1 (+1/0), contrasting with the
earlier standalone +1/-9 result. All 32 new executor VMs were removed, and all 92
recorded VMs were checked absent. Session state, selected replay and original
chess session were unchanged. Evidence:
`artifacts/chess-automatic/2026-09-18/evidence/regression-audit.json`.
This proves the automatic check and feedback path, not real automatic rollback or
statistically reliable improvement. Repeated held-out comparisons remain open.

Repeated chess qualification (2026-09-18): new format-3 reviews run three pairs at
each of two distinct saved positions, with alternating role order. One lucky
incident cannot qualify; rollback requires a negative mean and a majority of worse
pairs. Historical format-1/2 inputs still validate unchanged. Compact feedback and
UI summaries expose absolute outcome changes as well as relative gains and ranges.
All 61 chess tests, typecheck and web build pass. A recorded-result UI preview fits
320–1440 px; it is not a new live audit result.

Real 12-run evidence: `artifacts/chess-strategy-evaluation/2026-09-18T17-55-45.570Z`.
Incident gains +1/+1/+1 and regression-position gains 0/+9/0 passed the relative
gate. The baseline lost nine material points in all three runs at the latter
position; the candidate did so twice. This exposes a shared tactical weakness,
not strong or statistically reliable play. All 96 VMs were removed. Rollout
preserved both API views, saved session and audit/job/executor journals without
paid redispatch. Broader positions, longer games and reliable quality remain open.


Real automatic chess rollback (2026-09-18): version-scoped audits now recheck an
activation under changed evaluation rules while preserving historical receipts.
The actual 12-run full-loop audit measured opening gains -4/-3/+1 and restored
the original source at epoch 2. The board and history were unchanged by rollback;
subsequent gameplay reached 14 plies using epoch 2. The live comparison viewer
showed real audit progress. This closes the previous real-rollback evidence gap,
but does not establish reliable chess strength or complete the broader quality
requirements. Evidence: `artifacts/chess-automatic/2026-09-18/evidence/versioned-audit/`.


Safe chess restart after the full-loop audit (2026-09-18): the subsequent review
finished and rejected its candidate before shutdown. The restarted host preserved
both game views (apart from the added active-proposal flag), complete session,
revision/audit/automatic/job/executor values and did not redispatch paid work.
The job decoder reordered JSON keys without changing values. All 775 recorded
executor VMs were released and verified absent. The historical-proposal status
correction is now loaded. Evidence: `versioned-audit/restart-complete.json` under
the chess automatic run's evidence directory.


Chess new-game flow (2026-09-18): finished games now expose New game, retain their
selected replays under Previous games, and start a fresh paused board with zero
current-game counters/checkpoints. Goals, settings, experience and active learning
carry forward; game context invalidates stale proposals. Intent-before-allocation
and staged publication recover interrupted starts without deleting the old game.
The live 97-ply draw restarted at revision 2; all 98 old frames and the fresh board
survived a host restart with unchanged learning journals. Original plain chess is
unchanged. This completes another-game creation within the selected chess session,
not the broader cross-game catalog or migration requirements. Evidence:
`artifacts/chess-new-game/2026-09-18/`.
