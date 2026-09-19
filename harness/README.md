# Gameplay harness

A standalone TypeScript library being extracted from Multiverse of Madness.
It provides game-independent infrastructure through explicit adapter contracts.
Extraction is in progress; the full session lifecycle is not yet migrated.

The core has no Doom, model-provider, Microsandbox or UI dependency. Node-specific
persistence and replay storage are exposed separately through `/node`.

```sh
npm ci
npm run check
npm run check:package
```

See [Integrating an existing game](ADAPTERS.md) for the adapter and host boundaries,
capability limitations and a clean tarball-consumer check. `npm pack` builds the
ESM package locally; nothing is published by these commands.

Game adapters supply their observations, inputs, clocks, executable plans,
progress/outcome measures and capability declarations. An exact fork, an
execution checkpoint and a replay recording are different capabilities.

## Describe a game to the supervisor

`GameDescription` is a versioned, serializable description of host-owned mechanics:
observation fields, controls and their preconditions, simulation timing, executable
plan payloads, measured outcomes, runtime capabilities and known limitations. It
contains no private acceptance cases or strategy recommendations. Paths use JSON
pointers relative to observations, commands or plan payloads as documented by each
section; the empty pointer denotes the whole value. Controls with no parameters
can use an empty field list.

Call `validateGameDescription(description, { adapter: adapter.version,
capabilities: runtime.capabilities })` before supplying it as supervisor evidence.
Validation rejects mismatched identities/capabilities, unresolved legal-choice or
clock references, duplicate identifiers, unknown fields and non-JSON data. It does
not implement game rules or verify prose: the adapter must test the description
against real observations, commands, timing and measured outcomes. The host still
validates every generated plan and independently measures results.

The consuming chess example builds its description from the active adapter and
runtime and supplies it through the existing source-proposal request. This is an
additive interface: existing `GameAdapter` implementations are unchanged. It is a
foundation for strategy bootstrap, not proof that arbitrary games can already
learn a strategy or complete a run unattended.

The intended supervisor can propose executable learning-system revisions, test
against a frozen baseline and request promotion. It does not own the canonical
experiment history, hard budgets or independent acceptance metric.

The portable curriculum helpers expose host-authored practice menus, validate a
supervisor's case selection and resolve immutable input copies. Chess uses them
for optional practice with separately recorded feedback; acceptance remains a
host-owned comparison. See [practice integration](ADAPTERS.md#let-the-supervisor-choose-practice).

This package lives in `harness/` inside the Multiverse of Madness repository,
alongside the Doom and chess demos. A normal clone includes all source files.
It can be built and consumed independently through the directory or a tarball.
The core defines the `ExecutableProvider` interface; the concrete isolated
Microsandbox executor lives in
[`packages/executor-microsandbox`](../packages/executor-microsandbox/README.md)
in the same repository.

Currently consumed by the Doom application:

- `BudgetLedger`: one total ledger across worlds and models, atomic reservations,
  durable publication before dispatch, conservative accounting of uncertain work,
  restart recovery and cancellation joins. Resources use integer quanta. Zero is
  a hard limit; omitted limits are uncapped. Observed-only resources cannot be
  configured with a hard cap without a reservation bound.
- `compareRevisions`: paired scenarios under identical total simulation/model-call
  caps, alternating execution order, independent acceptance metrics and per-case
  regression limits. Errors, timeouts, overruns and detached work invalidate the
  comparison. Trusted host adapters meter all revision work and own measurement.
  An optional `rejectAfterPair` host hook can reject after a persisted, joined pair
  and skip remaining scenarios. It cannot qualify an incomplete comparison.
  Include its semantics in the evaluator identity.
- `resolvePolicy`: validated defaults → adapter → profile → session layers,
  immutable results and serializable layer provenance. Arrays replace; nested
  objects merge. Schema adapters must reject unknown fields.
- `/node` `contentRevision`: canonical JSON content digests for policy and
  evaluation identities. Lossy JSON values and unsafe object fields are refused.
- `LearningLoop`: shared decision, continuation, trial, selection and recovery
  ordering. Doom supplies mechanics and outcome judgments through grouped ports.
- `routeDecision`: explicit confidence/manual/stall routing and bounded candidate
  selection, rotating through eligible alternatives after failed comparisons.
- `decideCurrent`: stale-judgment rejection with a bounded attempt count when
  instructions change; provider errors remain visible instead of being retried.
- `runTrials`: independent equal-duration trials, pinned budgets, resumable clocks,
  cancellation fences, terminal handling and bounded zero-time replanning.
- `ExecutionGate`: exclusive operation ownership; stopping waits for dispatched
  work and cleanup before control can transfer.
- `WorldForks`: durable fork intent, acknowledged physical identities, validated
  child attachment and restart reconciliation without repeating creation. Failed
  publication restores registry/domain metadata and keeps the recovery journal.
  The runtime adapter must settle all dispatched work before returning, including
  cleanup; recovery must distinguish definitive absence from pending creation.
- `WorldLifecycle`: world identities, durable promotion, failure rollback and
  runtime cleanup, with source VMs retained until selection is published.
- `CheckpointRecovery`: capture/restore journals, checkpoint retention, exact-state
  adapter validation, interrupted-operation recovery and serialized cleanup.
- `EvidenceMemory`: bounded retrieval with adapter-owned relevance and evidence.
- `collectLeafArtifacts`: leaf-first cleanup while retained descendants protect
  their ancestors; the storage adapter keeps its own deletion guard enabled.
- `/node` `JsonFileStore` and `ReplayStore`: atomic checkpoints and retained replay
  ancestry. The historical replay index uses `ticks`/`startTick` as opaque integer
  cursor fields; the adapter supplies their meaning and segment size.

Await `ReplayStore.retainPath(id)` before publishing a selected world or checkpoint.
It marks the known ancestry as retained, then publishes its buffered frames,
including new frames on an already selected world. Publication failures reject
the call and leave pending frames available for retry. Ordinary recording stays
buffered; the retention barrier flushes only the selected ancestry. The on-disk
format is unchanged. This protects acknowledged selection/checkpoint footage
across process restart, not power loss; it cannot restore previously missing
history or footage discarded after a recording error.

`runTrials` uses seconds or turns, never a fixed game tick rate. Adapters must
honor cancellation before issuing another input and settle already-dispatched
work before returning. A failed sibling cancels the group; all work is joined
before the original error is surfaced. An adapter that returns 64 times without
advancing simulation time fails explicitly (configurable per run).

The initial `GameAdapter`, model and runtime contracts describe the intended full
boundary. Promotion and checkpoint transactions now use the core, while the
consuming demo still owns retry policy, game-plan execution and domain-specific
attachment/measurement. Fork publication and reconciliation now use `WorldForks`. `LearningLoop` owns cycle ordering and cancellation
boundaries; the host owns its execution gate and repeated-cycle scheduling. The revision controller now owns supervisor proposal, qualification, activation and rollback
history. A separate Microsandbox provider now executes verified source artifacts;
the consuming chess example now exercises continuing-session activation, restart
and rollback with real isolated executables. Live Doom activation, autonomous
proposal generation and held-out improvement qualification remain unfinished.

Lifecycle operations require a quiescent source. The host must fence gameplay
before requesting checkpoint capture or replacement. Once a durable transition
is in flight, cancellation waits for it to settle; it never detaches VM work.
Checkpoint attachment must verify actual restored state against saved adapter
data. Staged metadata hooks return synchronous undo operations for publication
failure. Cleanup shares the checkpoint transaction queue, so it cannot consume
uncommitted pruning decisions. `CheckpointRecovery` accepts a fixed numeric
retention limit or a getter for revision-controlled policy. It resolves and
validates the limit before each capture, retaining that value through publication
even if a later revision changes the getter. Fixed limits preserve their original
constructor value; checkpoint journal formats are unchanged.


## Supervisor revisions

`RevisionController` is the single writer for a durable active learning revision.
A revision contains typed policy, prompts, skill instructions and immutable
adapter/model/executor references. Host verification checks schemas, content
identities and actual executable artifacts; it must not execute proposed code in
the trusted host. This controller is not an executable isolation mechanism.

1. `create(initial, rules, ports)` verifies and publishes the initial revision.
2. `submit({ id, candidate, reason, expiresAt, expected? })` derives changed capabilities,
   enforces the host allowlist and pins the active epoch and user-context identity.
   For asynchronously generated proposals, pass `expected: { activation, context }`
   captured before generation. A changed guide or activation epoch refuses the
   submission, including rollback to the same earlier artifact.
3. `evaluate(id, signal)` invokes the trusted evaluator with the fixed contract.
   It retains acceptance/rejection evidence and checks all returned identities.
4. `activate(id)` enters the host's decision/batch fence, verifies artifacts and
   state compatibility, and publishes the active pointer before exposing it.
5. `rollback(revision, reason)` can select only a previously active compatible
   revision. Every activation/rollback increments the epoch and preserves history.

The host owns the evaluator, user guide, hard budgets and runtime. Its `context`
reference must change whenever the user guide/overrides or other external
inputs change. The boundary must fence those changes as well as gameplay.
Consumers read `current` at the boundary and pin that artifact for each trial;
do not maintain a second independently persisted active pointer.

Qualifying a revision does not authorize changing the user objective. Domain
policy parsers must reject unsupported fields, including attempts to smuggle an
objective/evaluator override through a policy payload. `qualify` must meter and
join all work, usually through `compareRevisions`. No callback supplied by the
candidate decides its own acceptance. Artifact storage and executable isolation
are host adapters, not guarantees provided by a TypeScript type.

`restore` verifies the catalogue, qualification references and complete activation
history. In-flight qualifications become interrupted and require a new proposal;
they are never silently retried at additional model/simulation cost. A rejected
persistence acknowledgment poisons the controller even if the write may have
succeeded: reopen authoritative storage before gameplay continues. The host must
enforce exclusive storage ownership across processes. Changing evaluator/rules
requires an explicit journal migration, not silently accepting old qualifications.

## Executable artifacts

`ExecutableSource` is a versioned manifest of literal TypeScript/JSON files and a
TypeScript entrypoint. `/node` `ExecutableStore` publishes content-addressed
artifacts atomically and verifies their complete source hash on every read. It
never imports candidate modules or runs build scripts on the host. A damaged
existing artifact is refused rather than overwritten. Files, paths and total
source size are bounded and validated before a runtime receives them.

`ExecutableProvider.execute` receives a verified artifact, explicit JSON input,
host-owned resource/deadline/output limits and cancellation. The returned JSON is
untrusted: the game adapter must validate legal actions, and an independent
host evaluator measures the actual resulting game state. A guest cannot establish
success by returning its own score. Receipts identify the source, provider,
physical runtime, image, requested limits, elapsed time and stream sizes.

The consuming application provides a Microsandbox implementation with a pinned
Node image, no networking or host mounts, uid 1000 execution, fresh VMs per call,
stream/deadline enforcement and durable cleanup records. This is an integration,
not a dependency of the core package. The source entrypoint exports a default
function accepting JSON and returning JSON; TypeScript stripping happens inside
the VM. Credentials and game/evaluator storage are never copied into it. Model
calls remain host-owned; direct provider access from a candidate is not enabled.

`BudgetLedger` can hard-cap `executorCalls` and record `executorWallMs`. Observed
elapsed wall time is not a CPU-time measurement. Combined call caps, fixed VM
resources and per-call deadlines bound allowed execution; report cleanup and
failed-invocation receipts as well. Old budget journals without these optional
resources remain readable; older package revisions reject an unknown resource
instead of silently ignoring a new cap.


## Improvement providers

`SupervisorProvider<Policy, Evidence>` is the optional outer generation port. It
accepts a frozen revision/origin, typed observations, user objective, capability
allowlist, opaque evaluation-contract identity and proposal schema. The provider
returns untrusted data and an invocation receipt, never an activation decision.
Keep private acceptance cases outside the request. The consuming host validates
returned source/policy, stores content-addressed artifacts, submits against the
captured origin, evaluates, then activates only at the session boundary.

`validateSupervisorLimits` bounds deadlines, input/output bytes and the provider
spending cutoff. Providers must implement those controls and joined cancellation;
the interface alone does not enforce process or network isolation. Persist pending
invocations before dispatch and preserve actual serving models and usage after
failure as well as success. Unknown interrupted costs retain their reservation.
Provider-side cost cutoffs may overshoot; account the actual cost in the ledger.

The optional `supervisorCalls` budget resource counts outer invocations separately
from decision-model API calls. A coding-agent invocation can contain multiple
internal requests or retries, so it must not be reported as one known API call.
Old journals without this resource still load; older core versions refuse journals
using the new resource instead of ignoring the cap. The Claude CLI implementation
belongs to the consuming application, not the standalone core.

### Isolated learning stages

`executeLearningStage` composes an `ExecutableProvider`, `BudgetLedger`, durable
record callback and a host-owned typed validator. Use it for editable context,
retrieval, candidate generation or other preparation work. It freezes the input,
records raw execution evidence before domain validation, verifies the receipt's
artifact/provider/limits, and charges invalid outputs too. Cancellation cannot
produce an accepted stage result. The function imports no game, model, VM or
filesystem implementation; adapters supply those ports and keep independent
outcome scoring outside the executable source.

Automatic learning hosts may supply `activationObservation(previous)` to establish
an observation baseline after a revision activates, including activation recovered
after a restart. The callback is a pure, synchronous host observation. Its mark is
persisted with the activation outcome before another cycle can be admitted. This
prevents failures accumulated while testing the old revision from immediately
being attributed to the new revision. Rejected proposals retain their original
observation window, and omitting the callback preserves the existing behavior.
