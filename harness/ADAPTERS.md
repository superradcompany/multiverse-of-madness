# Integrating an existing game

The harness owns experiment and revision transactions. Your application supplies
game mechanics, storage, runtime access, model providers and scheduling. There is
currently no single `createGame()` entrypoint that assembles a complete session.
Implementing `GameAdapter` alone does not provide persistence or an autonomous
supervisor. The exported ports make those remaining responsibilities explicit.

## Install and verify the package

Use Node.js 24 or newer. From this harness checkout:

```sh
npm ci
npm run check
npm run check:package
npm pack
```

`npm pack` builds the compiled ESM exports and declarations. Install the resulting
tarball in a separate TypeScript application:

```sh
npm install /absolute/path/to/multiverse-gameplay-harness-0.1.0.tgz
```

The package is private and is not published to the npm registry. Do not substitute
a registry install. Node consumers need `@types/node` and `"types": ["node"]` in
their TypeScript configuration when using the Node entrypoint.

`check:package` copies only the source, tests, manifests and documentation to a
temporary directory, installs its locked dependencies, runs the core checks, then
packs and installs the tarball in a second directory. That consumer compiles with
declaration checking enabled and runs routing, equal-duration trials and durable
storage through the public exports. No app source or existing `node_modules` is
copied. Temporary directories are removed afterward. This check proves package
consumption, not game quality, VM isolation or a complete game integration.

Import portable APIs from `@multiverse/gameplay-harness`. Import filesystem stores,
content hashing and executable artifact storage from
`@multiverse/gameplay-harness/node`. Both entrypoints are ESM; CommonJS exports are
not supplied. Provider SDKs and game libraries belong to the consuming app.

## Define the mechanics boundary

Keep these types specific to the game, then implement the exported interfaces:

| Contract | Application responsibility |
| --- | --- |
| `GameAdapter<State, Command, Plan, Execution, Memory, Statistics>` | Observation clock, episode/terminal meaning, memory/stat updates, legal candidates, plan execution and measured outcomes |
| `RuntimeProvider<State, Command, Frame>` | Create/connect worlds, report capabilities and optionally restore/remove checkpoints |
| `WorldRuntime<State, Command, Frame>` | Read state, issue inputs, render, destroy and optionally branch/capture |
| `DecisionModel<State, Plan, Evidence>` | Choose a supplied executable candidate, report preferences/confidence and actual usage |
| `GameDescription` | Explain observation fields, legal controls, timing, outcomes and limitations to the supervisor |
| `CheckpointStore<T>` | Load, atomically save and flush owned application state |

An observation must retain enough history to reproduce rules that depend on the
past. A chess board image or FEN alone does not preserve repetition history.
Simulation clocks count actual turns or elapsed game seconds; model latency is
wall time and must not consume a gameplay trial's duration. Use monotonically
increasing sequence values within an episode.

`candidates` exposes feasible executable options. It can consume validated output
from an isolated, versioned strategy generator. Keep legality and input validation
host-owned: a supervisor can change strategy, but cannot redefine a legal move or
invent an observation. `start` and `next` translate plans into bounded commands;
`measure` reports observed outcomes rather than model confidence.

Call `validateGameDescription(description, { adapter: adapter.version,
capabilities: runtime.capabilities })` before giving the description to a
supervisor. Test its field meanings against the actual engine. The validator
checks structure and references, not whether its prose describes the game well.

## Declare only capabilities you can provide

`exactFork`, `checkpoint`, `restore`, `detached` and `render` describe different
abilities. A recording cannot resume execution. A screenshot is not a checkpoint.
Omit unsupported optional methods and set their capability flags to false.
The host must reject a plan whose `requires` cannot be met before dispatch.

Exact forks must preserve all outcome-relevant state, including randomness,
inventory, timers and hidden engine state. A deterministic board engine may
reconstruct from verified full history; that is not a VM snapshot. A visual-only
game without a restorable engine may support live decisions and recorded review
but cannot honestly claim exact counterfactual comparisons from one state.

World IDs locate resources; physical identities prevent attachment to replacements
that reuse a name. `connect` must verify both. The application owns all allocated
resources until cleanup is acknowledged, including failed experimental worlds.

## Assemble a continuing session

1. Use an `ExecutionGate` to fence play, pause, goal changes and revision changes.
   Keep scheduling in the host, independent of an attached browser.
2. Use `WorldForks`, `WorldLifecycle` and `CheckpointRecovery` for durable fork,
   promotion and restore transactions. Supply their storage, attachment and
   physical-state verification ports; retain the source until selection is durable.
3. Connect `LearningLoop` to game decisions, execution, comparison and recovery.
   `routeDecision` selects direct play or alternatives; `runTrials` joins equal
   simulation budgets and cancellations. Every dispatched input must settle before
   its owner returns, including after cancellation.
4. Record actual observations and selected ancestry using `ReplayStore` or a
   compatible store. Protect selected paths and referenced checkpoints during GC.
5. Persist version identities with session state. On restart, reconcile owned
   resources and unfinished transactions before accepting new inputs. Refuse
   incompatible state explicitly; do not silently replace its provenance.

The reusable classes provide transactions and ordering, not engine-specific
attachment validation, a universal session schema or a ready-made web server.
The consuming demo's `examples/chess/session.ts`, `runtime.ts`, `runtime-store.ts`
and `adapter.ts` show their composition for an existing rules engine. Those files
live in the demo checkout and are not included in this package.

## Add learning without blocking gameplay

Use `RevisionController` for immutable revision history and safe-boundary
activation. A `LearningRevision` separates policy, prompts, skills and executable
identities. Validate each proposed capability and execute untrusted source through
an isolated `ExecutableProvider`; the core itself does not sandbox code.

Use `AutonomousLearning` to coordinate persisted observe/propose/evaluate/activate
work. The host supplies deduplicated observations, a durable job owner and a
background wake loop. Freeze the user context and activation epoch before a
request. Apply changes only when those identities still match at a safe boundary.
Repeated unchanged observations must not create repeated paid jobs.

`compareRevisions` supplies paired evaluation mechanics. The host owns acceptance
cases and metrics, measures all attempted work (including discarded futures), and
rejects incomplete or stale evidence. Compare against the same saved game state
and fixed opponent/environment behavior. Qualification is distinct from strong
gameplay: establish strength with broader held-out positions and longer runs.

## Qualify your integration

Before claiming exact branching, verify two restored copies against complete
engine state and history, exercise distinct inputs, promote the full selected
world and reconnect it. Test cancellation after dispatch, interrupted publication,
cleanup retry and failed attachment. Prove replay follows selected ancestry after
rollback and restart. Use actual provider/game runs in addition to fixtures.

Before claiming autonomous improvement, show an observed failure causing a new
strategy, independent evaluation, safe activation and continued gameplay with its
original history. Also show rejection and regression rollback. Report missing
capabilities and inconclusive evaluations as limitations, not successful learning.
