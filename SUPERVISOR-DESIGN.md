# Supervisor-driven improvement of the learning system

Current implementation and remaining acceptance work: [completion checklist](COMPLETION-CHECKLIST.md). Dated milestones below are historical evidence.

Design status: partially implemented and qualified below. No Exo dependency has
been installed or selected. The gameplay harness remains a standalone TypeScript
library with replaceable model and runtime integrations.

## Required behavior

The supervisor is an improvement agent, not only a gameplay strategist. It can
inspect observations, traces, repeated failures, plan coverage and experiment
results; propose and evaluate changes to the learning system; retain revisions
that improve the user's objective; and roll back revisions that regress.

Mutable revisions include prompts, skill definitions, context construction,
experience selection, candidate-generation/execution plugins, outcome-shaping
weights, uncertainty routing, trial timing/breadth, curricula and learning code.
Adapter or executor code edits run in an isolated source workspace, produce a
versioned artifact, and undergo contract checks and matched evaluation before
promotion. This supports more than parameter tuning without granting an evolving
executor ownership of its own success records.

The existing user objective remains authoritative. Temporary gameplay subgoals
are separately recorded interventions, with evidence, scope and expiry. They do
not replace the guide. Code changes cannot silently overwrite a live run's policy.

## Stable execution and evaluation boundary

The supervisor submits changes through explicit revision/experiment interfaces.
The substrate owns canonical events, artifact digests, world identities,
checkpoint lineage, cancellation, resource limits and revision activation.
The independent evaluator owns the acceptance metric and held-out scenarios.

A revision may change shaped rewards used during search, but cannot rewrite the
metric that determines whether it actually improved, past failures, resource
accounting or the evidence used for promotion. Outcome metrics and budgets are
set by the user/experiment profile outside the mutable proposal workspace.

There are two different branching operations:

1. A gameplay fork compares candidate actions or plans from one game state.
2. A system experiment compares executor/policy revisions across fixed scenarios,
   seeds and total simulation/model budgets.

Every decision, checkpoint and replay records adapter, policy, model and executor
versions. Activation happens at a fenced decision/batch boundary. Each running
trial keeps its original revision; siblings cannot mutate one another's facts or
code. Rollback restores both the intended world checkpoint and an explicitly
chosen compatible revision, without erasing the experiment history.

## Exo assessment

Inspected upstream commit `79ac83e4ed349bb7b3f4d336346159d3f22196ff` on 2026-09-17.
Source checkout: ignored `.cache/research/exo`; no install scripts were executed.

- Exoharness separates durable state/resources from executor semantics. Exo is a
  recursively modifiable agent built on that substrate. This fits the improvement
  supervisor role more closely than replacing the game-adapter layer.
- There is an existing Game Boy/Pokemon example using a TypeScript harness and
  a PyBoy HTTP sidecar. It illustrates game tools, not qualification of our
  parallel-trial, winner-promotion and replay contracts.
- The project advertises early, unstable APIs. The stack includes a Rust core,
  TypeScript harnesses and service/tooling dependencies.
- Snapshot semantics are backend-specific. Docker uses filesystem images;
  Firecracker has full-VM snapshots. The snapshot documentation also notes a
  current-process restriction. None of these establishes Microsandbox support.
- No existing Microsandbox backend was found in the inspected provider registry
  or source search. Integration and behavior qualification would be new work.

Recommendation: extract the focused gameplay/experiment engine we already need,
with a supervisor port that an Exo executor or another agent can use. Evaluate Exo
for the outer improvement loop without coupling game session correctness to its
conversation or storage implementation. Do not recreate a general coding-agent
platform inside the gameplay harness.

Adoption gate: demonstrate one isolated policy/code revision, evaluate against a
frozen baseline, reject a regression, promote an improvement, restart both sides,
and reproduce the artifact and decision history. Measure integration complexity
and supervisor costs. Exact game forks must continue to use the qualified game
runtime; conversation forks are a different operation.

Sources:
- https://exoharness.ai/
- https://github.com/exoharness/exo/blob/79ac83e4ed349bb7b3f4d336346159d3f22196ff/exoharness/docs/spec.md
- https://github.com/exoharness/exo/blob/79ac83e4ed349bb7b3f4d336346159d3f22196ff/exoharness/docs/sandbox-snapshots.md
- https://github.com/exoharness/exo/blob/79ac83e4ed349bb7b3f4d336346159d3f22196ff/exoharness/examples/gameboy-agent/README.md
- https://github.com/exoharness/exo/blob/79ac83e4ed349bb7b3f4d336346159d3f22196ff/crates/exoharness/src/sandbox_provider/mod.rs

## Implemented controller boundary

The extracted TypeScript `RevisionController` now implements durable proposal,
qualification, fenced activation and rollback history. Changed capabilities are
derived from artifacts, not trusted from a proposal's declaration. Qualifications
are bound to baseline epoch, candidate, fixed evaluator contract and user-context
identity. A host must change that context identity for user guide/override edits.

The isolated Doom evaluation CLI consumes it for policy experiments. A real
regression was rejected and recovered from disk while retaining the baseline.
Unit/contract tests demonstrate improvement activation and rollback as well.
Executable references are validated by a host port. The subsequent isolation
qualification is described below; live activation and the full adoption gate above
are still unfinished.
That policy-only entrypoint is not an autonomous improvement supervisor or an Exo integration.

Executable isolation is now implemented through a separate Microsandbox provider:
verified TypeScript source artifacts run in fresh networkless VMs under host-owned
limits. Fixed chess cases exercise rejecting invalid code output, qualifying and
activating improved executable code, reloading it, using it to complete a fresh
position, and rolling back while preserving history. This proves the mechanical
code-revision path with controlled proposals. Autonomous source proposals,
held-out learning evaluation and integration into continuing live sessions still
remain; the full adoption gate is not yet satisfied.

## Continuing-session qualification

The chess host now connects the controller to a real continuing `ChessSession`.
The controller's journal remains the sole active pointer. The session keeps its
stable journal identity and records the producing activation epoch plus adapter,
model, policy and executable references with worlds, comparisons and footage.
Old checkpoints retain their historical references; their next decision uses the
currently active compatible revision. Unresolved comparisons and in-flight
operations refuse activation, and guide changes are fenced during publication.
Restart verifies historical activations before reconnecting worlds.

`ChessExecutableModel` loads verified source through the isolated provider and
passes explicit observations, user guide, policy, prompts and skills. The host
validates every returned legal selection and owns resource accounting and outcome
measurement. Numeric checkpoint retention remains compatible; a new getter form
lets revised retention policy take effect at the next capture while preserving
an in-flight capture's original limit.

`npm run qualify:executor` now drives three separate processes. The first rejects
invalid code, qualifies the mate selector, plays with the baseline, restores its
world checkpoint and activates the improvement. The second reopens both journals,
executes the selected source to checkmate, records its replay, and rolls back both
revision and world. The third reopens and plays using the original executable at
epoch 2 while retaining all attempts and activation history. All 15 real invocation
VMs were released; the subsequent provider inventory was empty. Evidence:
`artifacts/executable-qualification/2026-09-18T04-36-20.815Z`.

These proposals and fixed mate cases are still controlled fixtures. They establish
continuing-session activation, independent measurement and process recovery, not
an autonomous supervisor's ability to discover generally better code. Live Doom
activation and broader improvement evaluation remain unfinished. The next section
records the separate autonomous source-proposal qualification.


## Autonomous proposal provider qualification

The optional `SupervisorProvider` port now has a Claude Code implementation outside
the core. It passes observations and current source as bounded JSON, with no tools,
repository access or direct control of the evaluator/session. Returned code is
stored unchanged and runs only through the isolated Microsandbox executor. The
controller rejects a proposal whose generation activation epoch or user-context
identity has changed. Provider invocations have durable budget reservations and
receipts; a separate process owns timeout, terminal-signal and host-death cleanup.

The live qualification at
`artifacts/executable-qualification/2026-09-18T05-08-11.230Z` supplied two observed
training stalemates to Claude. It generated a deterministic move-selector from
those traces. The fixed acceptance evaluator independently measured 3/3 actual
checkmates against 0/3 for the baseline on positions withheld from the request.
The stored artifact exactly matches the returned source. Three separate processes
then demonstrated activation, continuing-session restart, replay provenance and
rollback to the original executable. Every one of 17 VM invocations was released;
a subsequent provider inventory was empty.

The successful medium-effort invocation took 72.611 seconds and reported $0.201893,
6,786 input tokens and 6,124 output tokens. Actual serving models were
`claude-opus-5[1m]` and auxiliary `claude-haiku-4-5-20251001`; the requested model
was an unpinned local default. Previous default-effort attempts hit two- and
five-minute deadlines. A one-second diagnostic proved authentication and basic
transport worked, but did not establish the precise reason for those generation
stalls. The provider records explicit effort rather than changing global settings.
Auxiliary token usage survives interrupted envelopes with an empty aggregate.

This satisfies a narrow autonomous source-generation adoption test. The cases are
handselected mate-in-one positions, and the baseline deliberately picks the first
legal candidate. The learned mate preference is not evidence of broad chess
strength, reliable multi-step improvement, or superiority over existing engines.
Live Doom revision activation, wider supervisor off/on evaluation and an Exo
provider remain unfinished. No live Doom state or guide was changed for this test.

## Doom session binding

The Doom `Session` now consumes the same revision controller through an optional
`DoomLearningBinding`. Policy changes respect sparse user overrides. Decisions,
trial children, execution checkpoints and recordings retain historical activation,
adapter, model and executable references. Publication is refused during unresolved
gameplay/comparisons and fences user context edits. Supervised session format 2
requires the original journal binding; the actual older reader cleanly refuses it.

`DoomExecutableModel` ranks host-owned feasible actions/plans using code executed
in isolated VMs. The host provides state, statistics, geometry feedback, the user
guide, skills and resolved policy, validates returned choices and measures actual
engine outcomes. Returned commands or self-reported scores are not accepted.

The three-process qualification at
`artifacts/doom-revision-qualification/2026-09-18T05-33-02.478Z` used real detached
Doom VMs and five real code-execution VMs. It independently compared controlled
wait/advance programs, activated the accepted source, continued after restart,
restored an exact execution checkpoint/frame, rolled back the learning source and
continued after a second restart. All 105 simulated ticks, including bootstrap and
discarded futures, were accounted across evaluation and continuation. Cleanup was
verified against complete runtime/snapshot inventories.

This qualifies the Doom binding and recovery path. It does not enable supervision
in the current server entrypoint, generate an autonomous Doom revision, or establish
stronger gameplay. The server/UI workflow and broader off/on evaluation remain
pending; the user's existing live session has not been changed.


### Cross-game strategy bootstrap and candidate coverage

The generic engine is not a universal game-playing policy. The current Doom
candidate generator is hand-written game-specific strategy, with targets derived
from observed state. Other games still require an adapter exposing observations,
legal controls, measurable outcomes and actual save/restore capabilities.

The intended supervisor must be able to create an initial reusable strategy and
candidate generator from that adapter contract, then revise it when observed
failures show missing or ineffective options. Jev selects among freshly grounded
candidates during frequent execution. The supervisor is not called to enumerate
options every turn. Persist and reuse generated strategy code, and independently
evaluate revisions before activation. Candidate generation must be replaceable,
not restricted to reweighting the seed menu. A capability missing from the adapter
must be reported as missing rather than fabricated by a generated strategy.

Doom's seed strategies are useful baselines, not the definition of the generic
harness. Automatic new-game strategy bootstrap is an outstanding deliverable;
existing generated Doom planner experiments do not prove it. Verification needs
a pre-existing non-Doom game, its independently supplied adapter contract, a
supervisor-authored generator, frequent Jev execution, measured outcomes and
resource cleanup. Hand-authoring that game's strategy would not prove bootstrap.
