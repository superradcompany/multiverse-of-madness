# Doom learning revisions

The server enables background learning for game-aware sessions at a safe decision
boundary. `DoomSupervisor` and `DoomLearningModels` own durable revisions and model
dispatch. The supervisor generates improvements, measures them independently, and
queues accepted changes for a subsequent exploration boundary. Historical build
identities remain enforced; older saved sessions are not silently migrated.

## Responsibilities

- `doomLearningBinding(controller, identity, model)` connects one durable
  `RevisionController<DoomPolicy>` to the game session. Its identity names the
  journal, not whichever revision happens to be active.
- The host verifies artifact hashes, policy schemas, model/adapter compatibility
  and source existence. The host supplies the independent evaluator and budgets.
  No proposal may select its own acceptance metric.
- `DoomExecutableModel` runs stored TypeScript through `ExecutableProvider`.
  Candidates are host-owned feasible actions or conditional plans. Source may
  rank those candidates; it cannot return arbitrary commands or authoritative
  outcome scores. The game engine supplies the measured outcome.
- Candidate input contains current engine state, stats, wall/barrier feedback,
  history, observed experience, the user's guide and enabled skills, revision
  prompts/skills, and the resolved policy including user overrides. Base artifact
  policy is separately available as `learning.basePolicy`.
- The model factory must consume the artifact it receives. It must not look up a
  mutable global "latest" module during execution or import candidate code into
  the server process. The built-in Jev path remains available for unbound sessions.

## Bind a session

For a new supervised session, pass the binding as the third `Session` constructor
argument. For an existing version-1 session, restore it without a binding, then
explicitly call `session.adoptLearning(binding)` while paused at a safe boundary.
Its baseline policy must equal `session.learningPolicy()` and persistence must be
attached. Adoption preserves game state, user guide, controls, experience and
recordings; it does not start play.

Wire the controller ports to that same session:

```ts
context: () => session.supervisorContext(),
boundary: work => session.revisionBoundary(work),
compatible: async (_before, candidate) => {
  session.validateLearningRevision(candidate);
  // Also verify this host can load the candidate's model/executor ABI.
},
```

Controller construction also reads `context`; when constructing the controller
before a new session, supply an explicit bootstrap context until the session is
attached. Never submit or evaluate proposals against that bootstrap context.

The boundary refuses an in-flight input/decision, an unfinished plan, an unresolved
comparison or manual control. Resolve that work before activation. Guide, skill,
control and memory edits are fenced until publication finishes. A changed guide
or override invalidates an older qualification. User controls apply after the
learning artifact's policy and survive activation and restart. They are stored as
sparse overrides, so changing the trial duration does not freeze every other
supervisor setting.

## Persistence and recovery

Supervised checkpoints use application format 2 and store the binding identity
and user overrides. The controller journal owns the only active revision pointer.
Session decisions, worlds, fork intents, checkpoints and recordings retain the
activation epoch, adapter, model and executable references that produced them.
Pre-adoption history remains explicitly unversioned; it is not attributed to a
revision retroactively.

Reopening format 2 requires the original binding. Historical references resolve
only to artifacts that were actually active at the recorded epoch. Missing or
forged references fail before VM reconnection. An old unresolved comparison cannot
be resumed against a different active revision. A failed publication/adoption
acknowledgment requires reopening authoritative storage; it never silently falls
back to the legacy decision maker.

World checkpoint rollback and learning-revision rollback are separate operations.
Restoring a world retains its old observation/plan provenance. Subsequent new
judgments use the controller's active compatible revision. Attempts and activation
history are retained. An active old plan must finish before changing revisions.

Ordinary unbound sessions still write format 1. The exact reader source from
`fd777f7` is retained in `fixtures/session-fd777f7/persistence.ts.source`; a test
compiles that unchanged reader, loads its original fixture, and verifies that it
cleanly refuses format 2. Do not remove the format marker to downgrade a
supervised run.

## Qualification

Run `npm run qualify:doom-revisions`. It uses separate artifact/storage directories
and real detached Doom VMs, never the user's `.data` session. Each source invocation
runs in its own networkless Microsandbox VM with a pinned Node image. All game
inputs, including discarded futures and bootstrap ticks, are metered.

Verified artifact directory:
`artifacts/doom-revision-qualification/2026-09-18T05-33-02.478Z`.

- Two hand-authored wait/advance programs received the same 14-tick, one-executor
  evaluation budget from the same physical game snapshot. The independent host
  measured displacement with a damage penalty: baseline 0, candidate 38.388842.
- Three processes qualified/activated the candidate, resumed it after host exit,
  restored the checkpoint's exact state and PNG frame, rolled back the learning
  revision, and resumed the original executable at epoch 2.
- User threshold override 0.5 survived every stage and reached the code input;
  selected replay ancestry and historical revision references remained intact.
- Continuing play consumed exactly 77 ticks: 35 startup ticks and 42 ticks across
  all six trial worlds. Evaluation consumed another 28 ticks. Five executor VMs
  were used. Complete provider inventories found no owned game VMs, executor VMs
  or execution checkpoints afterward; no cleanup references remained queued.

This is a controlled navigation/recovery integration test, not evidence of
stronger Doom play, autonomous Doom learning, or a generally better strategy.
The separate chess qualification demonstrates a Claude-generated source proposal.
Doom's server/UI proposal workflow and broader improvement evaluation are pending.

## Server integration components

`DoomSupervisor.open` loads the durable journal or creates an explicitly supplied
baseline. Its identity and controller journal publish together; there is no second
active revision pointer. Reopening a format-2 session supplies `expectedBinding`
and refuses a missing/different journal. Rules and all artifact contents are
reverified. An interrupted evaluation remains interrupted and is not rerun.
The caller must exclusively own the session and supervisor storage across processes.
The server entrypoint has not yet established that ownership or enabled the owner.

For a legacy session, call `owner.adopt(session)` at a paused safe boundary.
For an already supervised session, construct `Session` with `owner.binding`, finish
restoring it, then `owner.attach(session)`. Neither opening a journal nor attaching
starts gameplay. Only an unused journal can adopt a legacy session. Concurrent
adoption is refused. Capture `owner.origin()` before asynchronous generation and
supply it to `submit`; changed guide/overrides or activation epochs invalidate it.
`evaluate`, `activate` and `rollback` use the controller's existing checks.
Pause the session before `owner.close()`; close cancels and joins evaluation cleanup
and any adoption publication before returning. Concurrent close calls join the same
completion. The host must not release its storage ownership earlier.

`DoomLearningModels` verifies content-addressed artifacts and dispatches only two
supported combinations:

- The host's immutable built-in executor plus a TypeSafe Jev model. The baseline
  captures `TYPESAFE_DEFAULT_MODEL` or `jev-latest`; callers with a custom client
  default must supply that model explicitly. Actual serving model and token usage
  remain recorded per decision. An alias does not pin provider model weights.
- A verified stored TypeScript artifact plus `isolated-doom-ranking@1`. Its factory
  must construct `DoomExecutableModel` with the isolated provider and host budget.
  Candidate source is never imported by the model registry or server.

The host supplies the adapter and built-in executor build identities. Different
source/profile builds must receive different identities; this module cannot make
an arbitrary supplied build label immutable. Candidate adapter changes and other
executable ABIs are refused. The current source ABI ranks host-provided actions or
plans; it does not yet allow a candidate to replace the host game adapter.

Jev artifacts recognize `action`, `plan` and `priority` prompt slots and at most
eight learned skills. Their combined JSON is bounded to 2048 UTF-8 bytes. Unknown
slots, duplicates, unsupported models and changed content with an old digest fail
before decision execution. Questions retain their original instructions and legal
candidates; supplemental learned guidance explicitly defers to the primary user
guide and enabled user skills. Learned skills are separate from user skills in the
request. These are prompting constraints, not proof that a probabilistic model
always obeys them. Empty learned guidance preserves the existing question bodies.

`node --env-file=.env --import tsx scripts/qualification/doom-jev-revisions.ts`
performs two bounded real Jev requests over locally loaded Doom WASM observations.
The run at `artifacts/doom-jev-revisions/2026-09-18T05-55-04.355Z` passed both action
and plan requests, with 4415 input and 215 output tokens in total. It retains the
exact credential-free request bodies, responses, decisions, budget and source/asset
hashes. This qualifies API input/response handling; no VM gameplay, activation,
calibration or improvement is claimed. The user's running session was untouched.

## Proposal generation

`generateDoomProposal` captures the controller activation/context before generation,
then assembles bounded observations from the main route, active futures, the latest
decision, enabled user skills, explicit overrides and the last 12 experience
records. It excludes frames, private runtime identities, cleanup records and the
acceptance scenarios. Observations and the exact outgoing request have a content
identity. Commentary is excluded; model preferences remain labeled decision data.

The external provider can propose bounded policy/prompt/skill replacements or a
complete TypeScript source artifact. It receives only the evaluator contract ID,
not the independent acceptance data. Returned source is stored unchanged and never
executed during generation. Strict schemas and model/ABI verification run before
submission. The controller rejects unsupported capabilities and stale guide/epoch
origins. A successful generation only creates a proposed revision: it never calls
the evaluator, activates a candidate or changes the game.

Each job uses its own exclusively owned `CheckpointStore<DoomProposalRecord>` and
a shared durable host `BudgetLedger`. The caller must retain and reuse the same
store object for concurrent operations and exclusively own its path across hosts.
The function refuses concurrent invocation on that store, reserves a provider call
and spending cap before dispatch, and records raw output/receipts, actual usage or
the full uncertain reservation. An overrun stops submission and remains recorded.
The provider must bound and join its subprocess/network work; the Claude adapter
already supplies the watchdog and receipts. The caller owns cancellation and must
join generation before closing the supervisor or releasing storage ownership.

Existing records never silently trigger another provider call. An interrupted
request/response remains interrupted without automatic submission. If the
controller committed a proposal but the final job acknowledgment was lost,
reopening reconciles the matching candidate, origin and reason against the durable
controller journal. Mismatched jobs, request hashes or bindings are refused.
The web job manager and HTTP/UI commands are not wired yet.

Run `node --env-file=.env --import tsx scripts/qualification/doom-supervisor-proposal.ts`
for an isolated proposal-only qualification. The successful run at
`artifacts/doom-supervisor-proposal/2026-09-18T06-09-43.586Z` used real local Doom
WASM, two Jev requests and four trial futures. Its 385-tick training budget includes
all child initialization and replay reconstruction. It then made one tool-free
Claude invocation at medium effort: 30.463 seconds, 14710 input / 2021 output tokens,
reported cost $0.15003. The actual serving models were `claude-opus-5[1m]` and
auxiliary `claude-haiku-4-5-20251001`.

Claude proposed broader future comparison and pickup/stall guidance. The host
verified and submitted the unchanged artifact, kept activation epoch 0, and reopened
the same job without a second invocation. No independent gameplay evaluation,
source execution, VM fork, activation or improvement is claimed. The distance
cutoffs in the proposal are hypotheses, not verified mechanics. The first attempt
stopped at its insufficient simulation budget before invoking Claude; that record
is retained separately. The user's live game was only read for its current guide.

## Independent revision evaluation

`qualifyDoomRevision` is the reusable host evaluator. It accepts a frozen contract,
objective/user skills/sparse overrides, a metered runtime factory, a per-run model
registry, checkpoint capability, and a cleanup owner. It runs both immutable
artifacts through the real `Session` loop with the same scenario and resource caps.
Candidate policy/prompt/skill changes therefore affect normal decisions and forks;
explicit user overrides still apply last. A new-session initial context preserves
user skill identities and sparse overrides without replaying UI edits.

The evaluator meters built-in Jev calls and usage. Its runtime port must meter all
initialization, inputs, forks/reconstruction and checkpoint restores; executable
models receive the same ledger. The independent host metric measures engine state
and cumulative route stats, never a candidate-supplied score. The supplied
`doomSurvivalProgress` metric rewards surviving, exiting, kills, items, secrets and
novel cells. Its identity and the private scenarios belong to the fixed contract.
Other user objectives need an appropriate host-selected contract rather than
silently reusing these weights.

Every run owns its resources. Cancellation, startup errors and persistence failures
still invoke the cleanup owner; cleanup failure makes the run ineligible for
acceptance. Unsupported checkpoint recovery is refused instead of ignoring a
candidate setting. Provider errors are distinguished from typed budget exhaustion.
Only completed matched runs with valid accounting can meet the acceptance rule.

Run `node --env-file=.env --import tsx scripts/evaluation/doom-revision.ts <proposal.json>`
for the local WASM evaluator. It copies the exact proposal into a separate
experiment with a frozen evaluation contract; it never modifies the original
journal or activates a revision. Source artifacts, when present, use the isolated
Microsandbox provider; local game forks use charged deterministic reconstruction.
The local runtime cannot qualify checkpoint recovery settings. A live server
runtime factory still needs wiring.

The actual generated proposal was evaluated at
`artifacts/doom-revision-evaluation/2026-09-18T06-22-13.962Z`. Three first-map starts,
not supplied to the outer proposal model, each gave both sides 1050 simulation
ticks and 12 model calls. All six runs completed at the model-call cap. Total work:
3024 simulation ticks, 72 Jev calls, 158276 input and 7314 output tokens. The
candidate scored +99, -20 and -1 against its baseline; mean gain was +26. It was
**rejected** by the fixed no-per-scenario-regression rule. The experiment controller
remained at epoch 0. This is a short assessment with nondeterministic model calls,
not proof of general improvement or degradation across Doom. Source snapshots,
asset hashes, decisions, budgets, measured metrics and the controller journal are
retained with the report. Neither an executor VM nor live game VM was needed for
this guidance-only local evaluation.

Future proposal requests now include up to four prior experiment summaries:
rejected/accepted settings, changed capabilities, user-context match and aggregate
mean gain/regression counts. Raw acceptance cases, scenario identities, diagnostic
errors and free-form acceptance reasons are withheld. The detailed local journal
still retains them for review. This gives the supervisor feedback without letting
it rewrite the acceptance metric or treating its explanation as a measured cause.
Production runtime/evaluator selection, API/UI review and broader learning
qualification remain unfinished.

## Background job ownership

`DoomLearningJobs` owns one background generation or evaluation at a time. Admission
is durably recorded before provider dispatch and returns without waiting for the
experiment. A browser supplies a UUID as its idempotency key: retrying the same
request returns the existing job, including failed and cancelled jobs. Reusing the
UUID for another request is refused. A completed evaluation can have a rejected
outcome; that is distinct from a failed job. Jobs never activate a revision.

Cancellation aborts the provider/evaluator but retains the busy slot until cleanup
has joined. Shutdown joins the job before the caller closes its supervisor. On
restart, the owner first requires resource recovery, reconciles committed
proposals after lost acknowledgments, and marks unfinished work interrupted. It
does not construct a provider or replay a paid request during recovery. Failed
publication prevents further admission until the owner is reopened. Full proposal
packets, private acceptance states and source files are excluded from the polling
snapshot.

The application server now binds HTTP before opening stores, then acquires a
kernel-owned loopback lease for the canonical data directory. Separate HTTP ports
cannot circumvent the directory lease. A hard-killed process releases it without
PID-file recovery. This is a cooperating local-process lock; existing older
servers without it must be stopped before running an upgraded server on another
HTTP port. A hashed-port collision fails closed. `MOM_DATA_DIR` supports isolated
session/recording/movie directories for integration tests.

Nine focused tests cover durable background admission, duplicate requests,
cancellation before dispatch and during cleanup, shutdown, rejection status,
lost acknowledgments, restart without provider calls, blocked resource recovery,
symlink ownership and hard process death. The actual application entrypoint was
also invoked against the occupied live HTTP port and refused startup before
opening stores. The live backend was not restarted. The manager still needs the
production evaluator/resource owner and API/UI composition in `main.ts`.
The application/example suite passes 190 tests; type checking and the production
build also pass. These job/ownership tests do not claim VM gameplay qualification.

## Production VM evaluator

`DoomVmEvaluations` composes the paired evaluator with real Microsandbox worlds,
the normal `Session` loop, checkpoint recovery, immutable requests and durable
per-run budgets, observations and results. Its contract is fixed before proposal
generation. User context is rechecked before dispatch. Each proposal has a durable
one-shot manifest: reopening it recovers resources without repeating the experiment.
It is ready for application composition but is not yet enabled in `main.ts`.

`DoomEvaluationVms` owns physical resources beneath the existing logical session
lifecycle. It journals root/fork/restore/capture intent before dispatch, retains
acknowledged identities, and joins in-flight work before cleanup. The entire
experiment stops admitting new runs if cleanup is incomplete. VM initialization
costs 35 engine ticks; setup and every future input share the run's ledger. Exact
VM forks and memory restores advance no ticks. Runtime image, allocation, build
and independent metric are host-owned evaluation inputs.

Full restores do not inherit labels in the qualified runtime. Changing labels on
those VMs would require restart, which would destroy the captured in-memory game.
Cleanup checks the exact physical identity after acknowledgment and always requires
matching root ownership labels or the journaled parent snapshot plus pinned image
digest. Catalog-local numeric IDs alone are insufficient when changing runtime
homes. Forks of restored VMs carry that recorded
snapshot provenance too. No VM is restarted to attach labels. Snapshot cleanup
verifies identities and uses dependency-aware leaf deletion; it never forces a
parent removal. The adapter converts the collector's deleted-reference result to
its pending-resource journal and preserves the Session adapter's deleted-reference
contract.

Physical qualification:
`artifacts/doom-evaluation-vms/2026-09-18T07-06-01.982Z`. Real forks and a full restore
preserved exact engine observations and PNGs. All child inputs and bootstrap used
63 charged ticks. The creator exited with five detached VMs still owned, including
an unlabeled restored-world fork whose acknowledgment was deliberately lost. A
second process recovered every VM and checkpoint, checking each catalog identity
for absence. Earlier attempts exposed the label and collector contract mistakes;
their failed evidence is retained, and all their resources were verified released.

Composed evaluator qualification:
`artifacts/doom-vm-evaluation/2026-09-18T07-03-11.122Z`. Both roles completed through
the real Jev/VM session loop: four model calls, 140 total ticks and ten game VMs,
including trial futures, plus automatic checkpoints. Every recorded VM and
snapshot was verified absent after cleanup. The hand-authored prompt candidate
did not improve the independent score and was rejected. No revision was activated
and the user's live session was unchanged. One short first-map comparison proves
composition and accounting, not broad gameplay strength or calibration.

Reproduce with:

```sh
node --import tsx scripts/qualification/doom-evaluation-vms.ts
node --env-file=.env --import tsx scripts/qualification/doom-vm-evaluation.ts <successful-ownership-directory>
```

The second command requires the exact first command's source/asset hashes. Normal
unit tests use explicit runtime/model fixtures and do not claim real sandbox work.
Remaining work includes the production service/budget/provider composition,
API/UI review, broader mutable learning components and the full requirement audit.
All 199 application/example tests, type checking and the production build pass.

## Automatic application learning

Self-learning starts with the game-aware session. Current controls become the
baseline; the user guide and enabled skills retain precedence. For an existing
unsupervised run, initialization waits for a safe decision boundary without
resetting gameplay. Returning control to AI and resolving an unfinished plan or
comparison allows that boundary to be reached. A restored pause preference stays
paused. The baseline profile does not enable this supervisor.

The header has a small supervisor status indicator. Playback settings contains
one background self-learning toggle and a Codex/Claude selection. There is no
Learning lab, manual proposal workflow, or token/spending panel in normal play.
Persistent failures trigger occasional analysis; healthy progress does not call
the supervisor periodically. Jev still chooses and executes plans each turn.
Tested improvements apply at a safe decision boundary and appear in commentary.

`DoomLearningService` composes durable jobs, the CLI provider, independent VM
evaluation and isolated code execution. `GET /api/learning/status` is the small
polling payload for normal gameplay; it excludes source, history and usage.
Diagnostic APIs remain available: `GET /api/learning`,
`GET /api/learning/proposals/:id`, and the existing POST commands. They are not
required to drive self-learning. Rejection never replaces the active revision.

Supervisor generation now defaults to Codex CLI, with Claude CLI selectable per
request. Both bypass permission prompts and have no harness cost, request-count,
turn-count, time or input/output-size caps. Usage is recorded, not enforced as a
spending allowance. Independent gameplay evaluation starts with three paired starts and
base allowances of 4,200 ticks, 64 model calls and 64 executable calls per run
(180-second wall limit). New learning lineages use `complete-futures-v1`: before
either strategy runs, the host raises those allowances when needed to cover the
configured trial duration, permitted breadth and decision cadence for both sides.
The wall limit scales with the largest resource increase. Initialization and all
alternatives share the resulting tick allowance. Jev costs
are separate from the Claude spending ledger. The supervised live session has
10,000 model calls and 1,000 executable calls. Interrupted calls without final
receipts conservatively consume their reserved allowance. These are bounded
initial defaults, not calibrated gameplay quality guarantees. Every nonterminal
run must commit six seconds of selected gameplay before it is eligible for
comparison; spending the budget on unfinished futures is insufficient.

The service persists under `MOM_DATA_DIR/learning` (default `.data/learning`). Its
manifest freezes the host contract, runtime image, budgets and gameplay build.
Enablement retains source/asset bytes and their digests; reopening a supervised
session with a different gameplay build refuses substitution. This currently
requires restoring the retained build, including matching installed dependencies
and Node, rather than silently migrating an active experiment. UI-only changes
are excluded from the gameplay fingerprint. Existing unsupervised sessions remain readable and are adopted at a safe boundary
when background learning is configured.

Service integration tests use explicit runtime/model/provider fixtures. They
exercise opt-in adoption, unchanged guide/settings, proposal accounting, all six
paired runs, rejected activation, cleanup, restart/idempotency, stale user context
and build mismatch refusal. They do not claim real VM execution or improved play.
Broader executable candidate generation, context selection and curricula still
need implementation and qualification.

The first full service/UI qualification exposed an acceptance weakness: most
runs consumed twelve model calls before promoting any future. One incidental
pickup was enough to qualify the candidate against effectively idle baselines.
That result was not activated. Its complete evidence remains at
`artifacts/doom-learning-service/2026-09-18-initial-coverage-gap`; all thirty
experimental VMs, their checkpoints and the one test-session VM were verified
removed. Reopening that session after the evaluator change correctly refused the
changed gameplay build.

The production contract now requires 210 committed ticks (six seconds) per
nonterminal run and allows 4,200 total simulation ticks and 64 model/executable
calls. Coverage is independently checked after the run, before scoring. The
regression test proves that an otherwise accepting score rule cannot accept
insufficient gameplay. Partial traces remain recorded for diagnosis. This gate
measures selected play, not summed trial time, and terminal deaths still count
as valid losing outcomes.

The live app handoff preserves the previous paused game, guide, all five active
world observations and all 848 recording entries, including unchanged retained
replay bytes. Evidence: `artifacts/learning-service-handoff/2026-09-18`. Learning
remains off for that legacy session. The browser review confirms the panel fits
its viewport with no horizontal or body overflow and no captured console errors.
The application/example suite now passes 203 tests; type checking and production
build pass. Full source-mutation breadth and the final requirement audit remain
outstanding.

Full corrected service qualification:
`artifacts/doom-learning-service/2026-09-18-coverage-gate`. A real Claude-generated
prompt/skill proposal was evaluated unchanged against three private first-map
starts using real Jev and detached VMs. All six runs completed 18–31 seconds of
selected gameplay. Score gains were +45, +13 and +11 (mean +23, no case regression)
under the frozen host metric. The experiment charged 21,249 simulation ticks and
384 model-call reservations, with 803,293 reported input tokens and 41,724 output
tokens. Model-call reservations include failures/cancellation without a final
receipt; they are not a claim of 384 successful responses. The proposal's Claude
cost was $0.119442, separate from Jev usage.

Browser activation moved the isolated session to epoch 1. A real server restart
retained that revision, game state and spending. Reposting the original generation
and evaluation commands did not dispatch again. Browser rollback restored the
baseline at epoch 2. Every one of the 117 experimental VM names and each owned
snapshot was verified absent, and the isolated test session's VM was destroyed.
No proposal was activated in the user's legacy session. This qualifies the
service workflow and one small held-out comparison, not general game mastery,
statistical calibration or executable-component breadth.

## Editable preparation, retrieval and candidate generation

Executable revisions now have two distinct interfaces. Existing
`isolated-doom-ranking@1` artifacts retain their original host-candidate ranking
contract. New `prepared-doom-jev` artifacts execute a versioned TypeScript
preparation stage, then call the selected `jev-*` model. The supervisor can return
`kind: "planner"` with unchanged source, optional model selection and the existing
policy/prompt/skill replacements. Generation still does not execute or activate
source. Model and executor references participate in the immutable artifact.

The `doom-preparation/1` input includes current observations, authoritative guide
and statistics, enabled user skills, geometry feedback, history, the retained
experience pool when memory is enabled, the user's experience limit, and optional
host plans/visited cells. Preparation returns selected history/experience indices,
bounded derived features and optionally a newly generated plan menu. It can change
retrieval and plan construction instead of merely ranking a fixed menu. Jev sees
the selected real observations and generated candidates. Derived features are
explicitly marked suggestions and cannot overwrite current stats or the guide.

Host validation rejects unknown fields, invented memory indices, duplicate plans,
unobserved actor targets, attacks against non-enemies, excessive local targets or
step durations, and plans in action-only mode. Plans have at most ten candidates
and twelve steps per candidate; existing motor controls own collision handling,
aiming, interruption and the actual trial horizon. Novelty is computed by the
host. The source cannot change the independent acceptance metric, runtime
permissions or spending limits. Disabled memory supplies an empty pool. The
session's displayed attempt evidence is the actual selected evidence, not the
previous host retrieval result.

Each preparation uses the generic harness `executeLearningStage` function:
frozen input, isolated execution, durable raw input/output/receipt, host validation
and one metered executor call. The subsequent Jev invocation consumes one model
call separately. Invalid preparation still consumes its execution but cannot
invoke Jev or apply a plan. Executor input permits up to 1 MiB for the retained
pool; derived features remain bounded to 2 KiB before the ordinary Jev input
budget. Nothing is imported from proposed source in the host process.

Qualification: `artifacts/doom-prepared-model/2026-09-18T07-55-51.350Z`.
Hand-authored diagnostic TypeScript ran in a real networkless executor VM,
generated two new local routes, and supplied them to real Jev. A real game VM
forked both futures, ran each to the 35-tick horizon and promoted the selected
world. The shared ledger charged 105 ticks (35 initialization plus two 35-tick
trials), one executor call and one model call. All game and executor identities
were verified absent after cleanup. Earlier diagnostic-script assertions failed;
their evidence remains and their resources were also cleaned. This is integration
qualification, not an autonomously discovered strategy or a quality improvement.

The core now passes 100 tests and the app/example suite 209. Further work includes
an autonomous preparation-code experiment, editable execution/outcome shaping and
curriculum components, and the full extraction requirement audit. Existing active
supervised runs remain bound to their original build; no upgrade is substituted.


### Choosing a proposal focus

The diagnostic API can request strategy/instructions, planning and memory code,
or decision code specifically. Automatic learning chooses its own focus. The optional
`proposalKind` on a propose command is `guidance`, `planner`, or `executor`.
It is saved with the job and included in the hashed provider request and output
schema. A response of a different kind fails without publication; its raw response
and spending remain recorded. Reusing a job id with a different focus is rejected.
Existing requests without a focus retain the supervisor-choice behavior.

### When every future dies

The Doom adapter rejects a batch with no surviving candidate. With checkpoint
recovery enabled, the configured retry/rollback policy applies. Otherwise the
unchanged source remains main, failed futures are archived, and play pauses with
an explanation. Resuming can try other opening candidates; a death in a speculative
future is not reported as a runtime failure or promoted into the main run.

Planner proposal evidence includes a bounded observed input example produced by
`doomPreparationInput`, shared with the executable model, and the host's output
JSON schema. The raw planner `state` has `x/y/z/angle/health` and actor
`position` fields; it differs from the separately summarized supervisor evidence.
This example is not a held-out evaluation state. Generated source is retained
unchanged even when it fails validation or evaluation.


### Search reward revisions

A proposal can optionally set `policy.outcomeWeights` for survival, exploration
and combat priorities. Each contains bounded nonnegative weights for health,
kills, novel cells, items, secrets, ammunition and level exit. These affect future
ranking only. Dead futures remain ineligible and the independent acceptance
metric is unchanged. All siblings use the policy reference captured with their
opening decision; subsequent judgments do not silently rescore the batch.

Omitting the field preserves historical scores and policy digests. Current code
restores old policy records unchanged. A previous reader cleanly refuses a new
record containing the field. New shaped policies are only introduced through
versioned supervised revisions, with their existing review, evaluation, activation
and rollback gates.

Subsequent proposals receive aggregate evaluation completion/failure categories,
including insufficient committed gameplay and replanning without simulated time
advancing. Private scenario identities, observations and raw errors are omitted.


### CLI selection and uncapped generation

`POST /api/learning` accepts `provider: "codex" | "claude"` on `type: "propose"`;
new requests default to Codex. The chosen CLI is stored in the job, so repeated
UUIDs cannot silently switch providers or rerun a completed/failed invocation.
The UI uses Suggest improvement, Test improvement, and Use improvement to distinguish
generation, independent testing and activation.

New generation usage is recorded in `supervisor-usage.json` without spending caps.
An existing `proposal-budget.json` is read for historical totals and remains unchanged,
including overruns. Old request records and manifests are retained. The optional
`unrestricted` marker records the new generation mode; the old manifest limits no
longer constrain new supervisor requests. An older job decoder will refuse new
provider-tagged jobs rather than silently dispatching another CLI.

Claude reports dollar estimates; Codex reports tokens without a dollar figure.
The UI reports unknown cost explicitly and does not treat it as free usage or an
account invoice. Cancellation remains available. Game-evaluation and isolated
candidate-execution limits are separate from supervisor generation.

### Evaluation spectator panel (2026-09-18)

The retained diagnostic spectator component reads the evaluator's durable session frames and
run results through a read-only spectator projection. It shows current strategy
and proposed improvement side by side, follows the active starting scenario,
counts finished runs, and exposes selected-route and trial-future previews.
Route stats are labeled separately from the inspected future's map stats. A run
that exhausted its equal test allowance can still be complete; failure, timeout,
interruption and not-run are separate statuses. Completed runs retain their last
captured frame and final score in this view, including after server restart.

These are sampled saved previews, not a continuous video or a full replay. Full
evaluation recording/replay remains unfinished. The reader never attaches to VMs,
steps a game, changes evaluation limits, or exposes raw model input. It caches
compact projections and a bounded set of content-addressed preview images. The
existing evaluation artifacts remain the source of truth. No gameplay build,
evaluation metric, active revision or saved session format changed.

Validation: 223 application tests passed; TypeScript checking and production web
build passed. A read-only browser preview displayed actual running evaluation
frames and advanced from four to five finished runs while the sixth played.

### Background learning and supervisor token use

The development implementation uses a durable background coordinator. The server automatically initializes learning at a safe decision boundary and observes gameplay, generates an improvement
when needed, compares it independently, and queues a passing revision at a natural
gameplay boundary. Jev continues to select and execute plans. Manual experiment
commands remain available through the diagnostic API; they are not required for this loop.

The one-second observer timer runs ordinary TypeScript and makes no model call.
Healthy play never schedules periodic supervisor analysis. An applied user goal change schedules a review after a three-second debounce, respecting the two-minute request spacing and one-cycle limit. The initial goal and reviewed goal are retained across restarts; rapid edits coalesce to the latest applied goal. Queued goals wait for the decision boundary so proposal evidence uses the same goal as Jev. Goal changes request a planner in conditional-plan mode or guidance in single-action mode. Gameplay continues while the review runs. Gameplay-driven escalation requires
three observed plan failures, three failed outcomes, or at least 15 game seconds
without selected-route progress plus 10 newly explored game seconds. Occasional
failed futures alone do not trigger a request. These are initial heuristics, not
calibrated guarantees about game performance.

The observer remembers the evidence already analyzed. Repeating the same issue
under an unchanged objective, skill revision, learned revision, map, progress and
health band does not cause another request. A new issue type or materially changed
context can warrant another analysis. The consumed observation and job IDs are
persisted before dispatch, so refreshing the browser or reopening the server does
not repeat the paid request. Automatic requests are spaced by at least two minutes
of wall time, including across game resets. The interval alone never triggers a
request. Only one improvement cycle runs at a time.

Ordinary escalation requests concise strategic guidance. Requests omit planner
source, execution ABI documentation and preparation examples, and use a smaller
sample of observed attempts and failures while retaining current statistics and
user constraints. Repeated plan failures can escalate to candidate-generation
changes; those changes still leave frequent selection and execution with Jev.
Tested guidance persists across decisions instead of being rewritten each run.
Actual CLI token usage remains recorded. Smaller request payloads and fewer calls
do not establish a measured dollar saving without real-provider qualification.

The standalone demo on port 4320 uses this workflow with its own data directory.
Earlier demo sessions remain separate and retain their original saved state.

### Keeping live frames independent of background work

Real paired comparisons execute in `doom-evaluation-worker.ts`, a separate Node
process at lower scheduling priority. It owns `evaluation-executor-runs.json`;
live planner execution retains `executor-runs.json`. The parent forwards a frozen
context and cancellation, and waits for cleanup. Worker disconnect aborts its
run; durable VM ownership journals support recovery after a crash. Fixture
adapters continue to run in-process for deterministic tests.

Observer polling uses a small projection of supervisor status, without cloning
historical evaluation traces. Validated immutable activation artifacts are cached.
The full evidence is retained for audit and subsequent supervisor requests.

Live recording uses a bounded 140-frame queue. It captures matching frame metadata
before the next tick and applies backpressure if storage cannot keep up. Selected
path retention and shutdown still join the recording queue. Committed replay
segments use a bounded read cache outside the writer queue and are checked against
current retention before delivery. Periodic session saves run at most once per
second; lifecycle transitions still await their immediate durable saves.

Browsers opting into the `mom-session-updates` WebSocket protocol receive one full
view followed by changed worlds plus current session fields. Existing clients
continue to receive full views. Reconnect sends a new full view. This reduces
resending archived game states without dropping gameplay observations or recordings.

These changes do not remove deliberate waits for Jev decisions or sandbox fork
creation. Measured frame delivery must distinguish those transitions from stalls
while an experiment is executing.

### Decision timing

Playback settings exposes **ask Jev again after** for both single actions and conditional plans. A fixed duration (0.2–60 game seconds) bounds the selected plan before another judgment; completion, danger and failure can request one sooner. **Match compare futures after** uses that batch's captured comparison duration, even if the next-batch setting changes during exploration. These are game-time intervals, not model latency settings. Active actions/plans retain their captured deadline; edits apply to subsequent decisions.

Existing sessions without an explicit timing mode retain their previous behavior: conditional plans run to completion or the trial horizon; single actions use their saved interval. Selecting a numeric duration explicitly chooses fixed timing. Selecting match persists the relationship in the backend and user policy overrides.

### Explicit gameplay build handoff

When changing gameplay code, stop the server at a resolved, paused AI decision boundary and run `node --import tsx scripts/upgrade-gameplay-build.ts DATA_DIRECTORY`. The command acquires the data lease, verifies the old learning history, retains the new build, and creates a separate lineage. It carries the current planner/guidance into a new baseline, without transferring its previous qualification to the new build. The session binding is published last, with a backup of the previous checkpoint; game state, recordings and historical provenance remain intact. Unresolved forks, running plans and evaluations must be settled first. This command is explicit maintenance, not an automatic fallback for a mismatched build.

Incident comparisons are connected to automatic learning. See **Comparisons from
the live situation** below for capture, qualification and cleanup behavior.

Live gameplay uses an uncapped `live-usage.json` ledger for Jev and planner calls. An existing `live-budget.json` is read only for historical accounting against its original manifest; it is never reset or rewritten to bypass a limit. Reported lifetime usage includes both ledgers, with null live call limits. Evaluation trials retain their separate finite trial contracts.


### Winner continuation and retired VMs

During automatic play, promotion durably publishes the selected world and the
exact identities to delete, then releases losing VMs in an owned background
operation. The winner can advance or request its next decision during that
cleanup. Pause, shutdown, rollback, and the next fork join cleanup. Failed
identities remain in the existing cleanup journal and prevent another batch
until reconciliation; cleanup does not accumulate across batches. Manual
promotion still waits for deletion before returning.

This removes cleanup from the continuation path, not Jev's decision latency.
`choosing next approach` means a world is waiting for its next decision, not
ranking trial outcomes. Automatic conditional-plan play prepares one next decision per world near the
current plan deadline. Lead time uses measured request latency, capped at 28 game
ticks. The request contains an immutable observed state, current stats, user goal,
policy, skills, and an explicit planning-ahead premise. Before use, the host checks
instructions, revision, duration, bounded player movement, resources, progress,
map events, newly close threats and continued actor-target validity. The normal
conditional motor still rechecks inputs every tick. Actions are never reused this
way. Pause joins speculative requests; losing requests are cancelled on selection
and joined before the next batch. Unused requests count toward recorded usage.

The real Jev/Doom smoke (`scripts/decision-prefetch-smoke.ts`) reused five of 14
decisions in its verified run: four boundary waits below 1 ms and one about 113 ms.
These observations do not establish that every gameplay pause is eliminated.
Decision details distinguish full request latency from blocking gameplay wait.

The user's maximum-futures control is a resource ceiling. Supervisor policy
chooses `breadth` below that ceiling; runtime records the clamped policy and
`effectiveFutures`, while preserving `maxFutures` as the user's setting. Historical
breadth overrides retain their stored shape but now supply the cap. Plan count is
independent: the validated planner menu allows up to ten plans.

Validation: `node --import tsx scripts/promotion-continuation-smoke.ts` creates
three private Doom VMs, holds one source deletion, advances the real selected
VM seven ticks during that hold, then verifies both retired VMs are gone and
releases the winner. This is a concurrency test, not a latency benchmark.

### Comparisons from the live situation

New proposals retain a physical checkpoint at the next completed-plan boundary.
The proposal sees observations from that checkpoint. Its comparison runs both
strategies from the same saved state, with the inherited exploration history,
failed-plan feedback, remembered pickups, experience and progress timer. User goals
and settings remain authoritative; historical simulation time is not charged as
new test gameplay or counted toward minimum coverage.

The saved situation must improve by the host's required score gain. The original
opening scenarios remain required non-regression checks; an unchanged opening is
allowed when the change improves the saved situation. Better opening scores cannot
compensate for failure to improve the stuck position. The original template and
exact instantiated comparison contract are both persisted. Historical proposals
keep their original evidence and are not relabeled as having passed this test.

The background comparison UI labels this case **Saved stuck position**. Each
checkpoint is retained through proposal generation and evaluation, then collected
after owned runs have joined. Pending descendants defer deletion; cancellation,
lost acknowledgments and restart do not repeat capture or generation.

Validation includes fixture service/restart tests and
`scripts/incident-qualification-smoke.ts DATA_DIRECTORY`: real private Doom VMs,
a deterministic model fixture, matched checkpoint restores, complete comparisons,
rejection of an unchanged policy and checkpoint collection. This validates the
workflow, not a claim that the supervisor has escaped a particular live room.


The evaluator now rejects after the saved-position pair if it did not improve or
could not complete. It skips the remaining opening games, retains completed-pair
results, and never treats partial comparisons as qualified. Both revisions use the
same user future ceiling; preferred breadth may differ within that ceiling.
Spectator gameplay time counts only new test time, while route totals retain the
inherited run.

Subsequent proposals receive bounded saved-position outcomes, plan-choice counts
across futures, final selected-plan status and recent stop reasons. Private opening
observations remain excluded. Build handoffs supply up to four recent verified
historical experiment summaries, explicitly marked as historical and outside the
current user context. They inform hypotheses but cannot approve a new revision.


### Supervisor visibility into Jev decisions

Each world retains one server-side diagnostic record of its latest consumed Jev
request: exact shared state, questions and candidate descriptions, executable plans,
selection probabilities, serving model and observation tick/map. This is copied
at the model boundary, so it describes the request actually sent, including learned
guidance and prefetch context. Forks inherit the source decision until their own
first question; the preferred option is not presented as the option that won a
comparison. Restart retains the record. Old sessions without one do not invent a
historical request, and a subsequent non-Jev decision clears it.

The supervisor receives the main world's record alongside current observations
and previous experiment results. It can compare what the planner offered with what
Jev saw and selected. Its preparation example includes the full bounded default
menu; only history and memory examples are shortened. The record stays out of
browser snapshots and frame updates. This adds diagnostic context at a supervisor
review, not an additional model call per gameplay turn.

After automatic activation, the observer records current attempt counters and
selected-route time as a fresh baseline. The two-minute review spacing starts at
that point. Failures accumulated under the previous strategy while a proposal was
being generated or tested do not immediately trigger another paid review. Fresh
repeated failures, continued stalled gameplay or a new applied goal can still
trigger review after the spacing interval. A paused game alone cannot. The baseline
and activation outcome are persisted together and survive restart.

### Movement recovery at plan boundaries

Collision recovery belongs to the current movement step. Reaching a waypoint,
changing steps or entering an aiming/interaction step clears that recovery intent.
Otherwise a recovery begun during approach could override a later turn or use
command and carry the player away from a switch. Both the input loop and the
post-frame condition check enforce the boundary.

The interaction reach is 64 world units, matching `USERANGE` in the pinned engine's
[src/p_local.h](https://github.com/theMagicalKarp/wasmdoom/blob/dd321b50b89b5085698cfbf2ff01b2f741da8206/src/p_local.h).
An attempted use remains distinct from observed activation; the controller does
not fabricate a successful interaction.

`scripts/diagnose-plan.ts DATA_DIRECTORY CHECKPOINT_ID [PLAN_FAMILY]` restores
private VMs from a retained user checkpoint and compares legacy recovery steering,
plan intent alone and recovery scoped to the current step. It also executes the
same plan through the production Session controller. This is a mechanical test,
not an AI quality evaluation or a live-route promotion. It writes traces/frames
and resource ownership journals under a temporary diagnostic directory, destroys
its VMs and leaves the borrowed checkpoint for its owner to collect.

The saved E1M2 diagnostic at tick 137543 reproduced the failure: legacy recovery
ended outside interaction range without a switch event. The corrected production
Session reached an engine-observed switch activation after 127 ticks, from the
same initial state. This establishes the control fix; it does not by itself prove
an autonomous escape or level completion.

### Read-only live performance observation

Run `node --import tsx scripts/observe-live-performance.ts http://localhost:4320 60 /tmp/mom-performance.json`
against an existing server. It creates no sandboxes or model requests. The report
measures delivered frame-version gaps, time in lifecycle phases, latest session
Jev decision waits, HTTP latency, stream volume and selected-route progress while
sampling supervisor activity. It adds one websocket plus two HTTP probes every
five seconds. These are delivery measurements, not browser paint FPS or a causal
comparison of supervision on versus off.

A 60-second live sample on 2026-09-18, with supervisor evaluation active, recorded
median exploration frame-version gaps of 36 ms (95th percentile 63 ms), decision
wait gaps of 656 ms and a maximum observed phase-transition gap of 3.54 seconds.
Frame HTTP latency had a 1.6 ms median. Five main-world changes advanced selected
play by 32.8 game seconds, adding one kill, two items and sixteen explored cells.
This points further investigation toward decision and lifecycle waits; it does
not establish that simulation or browser rendering is always smooth.

`scripts/executor-latency-smoke.ts` compares a fresh networkless VM with a forked
restore of a clean checkpoint containing the same test program. Each invocation
receives explicit JSON input, runs as uid 1000, observes only loopback, and writes a
marker that must be absent on the next invocation. The ownership journal and
measurements are written under a temporary directory. The script checks that its
VMs and snapshot are absent after cleanup. This measures a mechanical execution
path, not arbitrary learned-source isolation or game quality.

The 2026-09-18 three-run sample measured fresh creation/upload/execution/cleanup
at a 324 ms median versus 213 ms for clean-checkpoint restore/execution/cleanup.
Provisioning accounted for a 177 ms fresh median versus 69 ms restored; guest
execution remained roughly 73–85 ms and cleanup roughly 57–73 ms. This small,
sequential sample supports further prewarming work, not a live performance claim.
The current production executor still creates a fresh VM for each invocation.
A production prewarmed provider still needs retained-template ownership, bounded
cache eviction, cancellation/restart recovery and per-invocation labeling: the
benchmark observed that forked restore did not preserve the template's custom
ownership label. Exact recorded runtime identity allowed safe benchmark cleanup.

Checkpoint preparation also runs when a manual promotion or automatic rollback
ends at a safe paused boundary. A queued supervisor incident must not require a
second Play click after the comparison has resolved. While the capture is queued
or running, the UI says it is preparing a gameplay checkpoint; AI generation has
not started. Unresolved futures still require a selection or continued gameplay.

`node --import tsx scripts/paused-incident-smoke.ts` qualifies this lifecycle with
real Doom VMs and scripted decisions. It promotes a paused winner, captures it
without another gameplay step, restores the exact state, and verifies removal of
all four test VMs and the checkpoint. This does not measure Jev decision quality.

The browser now requests `mom-session-patches`: unchanged session fields (notably
commentary, decision details and settings) are omitted, with explicit removals
for fields that disappear. Each connection starts with a complete view and owns
its own cursor. HTTP command replies do not mutate that cursor. The older
`mom-session-updates` protocol and full-view clients remain supported. World
serialization is performed once per connection update instead of twice.

The 2026-09-18 overlapping 35-second live probes measured 36,952 versus 57,546
bytes per update (35.8% less), with no observer errors. Windows started about one
second apart; this is a delivery-payload comparison, not a browser FPS claim.
Exploration frame-version gaps had a 29 ms median, 56 ms p95 and 94 ms maximum;
the one observed decision waited 753 ms. Evidence and restored-session checks:
`artifacts/live-performance/2026-09-18/stream-patches/`.

The observer now defaults to the patch protocol; pass `mom-session-updates` as
its final argument to measure legacy delivery. Format-2 reports separate gaps
that include a paused interval and label main-world changes accurately: those
changes can be rollbacks rather than promotions.

Guidance-only supervisor requests include the same shared prompt/skill constraints
as code-capable requests. Their JSON output schema is built from the runtime Jev
guidance fields: supported prompt slots, per-field limits and skill count agree.
Planner proposals use these fields too; isolated ranking executors retain their
separate guidance contract. Aggregate UTF-8 size and unique skill identities are
still verified after merging any unchanged fields. Invalid drafts are recorded
without truncation, submission or an implicit repeat model call.

Evaluation allowance contracts are immutable. Historical contracts without
`complete-futures-v1` keep their original fixed limits; the explicit gameplay-build
upgrade creates a new lineage that opts into the rule. Version-3 evaluation
manifests retain both the template identity and the concrete shared allowance.
Candidate and baseline use the same limits, derived before observing results;
selected-gameplay coverage and independent acceptance criteria remain unchanged.
This provides room for complete futures, not a guarantee that stalled or failing
strategies will qualify.

`node --import tsx scripts/evaluation-allowance-smoke.ts` runs real Doom VMs with
deterministic judgments. The 2026-09-18 qualification completed four 60-second
futures per side with a shared 8,435-tick allowance (including initialization),
committed at least 60 seconds per side, and verified removal of all 18 VMs.
It verifies lifecycle and coverage, not Jev decision quality. Evidence:
`artifacts/evaluation-allowance/2026-09-18/`.

Supervisor observations now describe the effective decision interval, including
its link to the comparison horizon. The planner input example uses that same
interval; recorded historical Jev requests keep their original timing.

When a run fails the selected-gameplay coverage gate, its last observations are
retained in both its run record and comparison report. Its status remains an
error, with no acceptance metrics. The supervisor's saved-position feedback
includes committed seconds, exploration across futures, deaths, rejected batches,
retries and recovery's explanation. This distinguishes a batch rejected for poor
outcomes from a run that never executed. Private regression states are still
excluded. Old reports without these observations remain unchanged.

Add `--insufficient-coverage` after the data directory when running
`scripts/evaluation-allowance-smoke.ts` to test retained failure observations with
a deliberately small allowance. This uses real VMs and deterministic judgments;
it is a failure-path qualification, not a gameplay-quality test.

Offline upgrade recovery is covered by the service tests, including an actual
SIGKILL after a new lineage is prepared but before its session binding is written.
The original checkpoint remains authoritative, the kernel lease releases, and
the old build can reopen it. After explicit publication, the new binding reopens
without model calls. Source-retention failure, unresolved gameplay comparisons,
unfinished supervisor evaluations and tampered history cannot change the selected
checkpoint. These tests cover process interruption, not power-loss durability.

New offline preparations record ownership under `learning/.upgrade-work` before
staging files. Server startup and the offline upgrade command collect abandoned
work while holding the application data lease. The current session, explicit
`session-before-build-upgrade-*.json` backups and their embedded history protect
published lineages. Unpublished completed lineages are removed only when their
manifest and supervisor journal still match the preparation record. Changed,
unknown, symbolic-link and older unmarked directories are retained. Invalid
reference history defers cleanup rather than permitting deletion. No live VM,
checkpoint snapshot or recording is removed by this collector.
