# Gameplay harness architecture

The application experiments with possible continuations, measures what happened,
and keeps the selected world. Jev chooses executable options. A separate
supervisor can revise strategy after observed problems. Learning here means
retained experience and versioned strategy changes; it does not update model weights.

## Responsibilities

| Component | Owns | Does not provide |
| --- | --- | --- |
| [`harness/`](../harness/README.md) | Workflow ordering, world transactions, checkpoints, replay ancestry, evidence memory, evaluation and revision lifecycle | Game rules, a model, a VM implementation or a ready-made application server |
| [`examples/doom/`](../examples/doom/README.md) | Doom observations, geometry, controls, plans, scoring, session schema and viewer | Guaranteed navigation or competitive Doom performance |
| [`examples/chess/`](../examples/chess/README.md) | chess.js rules, complete board histories, legal moves, evaluation and viewer | A chess engine search, tablebases or a playing-strength rating |
| [`executor-microsandbox`](../packages/executor-microsandbox/README.md) | Owned isolated execution of versioned TypeScript artifacts, resource limits and cleanup | Authority to change canonical state or acceptance rules |
| [`supervisor-codex`](../packages/supervisor-codex/README.md), [`supervisor-claude`](../packages/supervisor-claude/README.md) | CLI invocation, cancellation and generation receipts | Automatic acceptance of generated proposals |
| Game backends | Scheduling, legal-input checks, persistence, credentials, user instructions and resource ownership | Cross-host ownership or multi-user authorization |
| Browser viewers | Controls, live presentation and replay | Ownership of the game loop |

The source is TypeScript. Doom's third-party engine is WASM. The harness is a
normal npm workspace in this repository, not a separate Git submodule. Its portable
entrypoint has no game, model-provider or runtime dependency; filesystem stores
and executable storage live under `@multiverse/gameplay-harness/node`.

## One gameplay decision

1. The backend observes the current world and captures its objective, settings,
   strategy revision and relevant experience.
2. The adapter supplies legal, executable options. An active generated planner
   may prepare guidance and candidates within the game's validated contract.
3. Jev ranks those options. Confidence describes preference concentration, not
   a calibrated probability of survival or winning.
4. Routing either executes directly or forks alternatives from the same state.
   Each trial can contain several subsequent decisions. Comparison duration counts
   game ticks or chess half-moves, not model latency.
5. Host-owned scoring compares measured outcomes. Promotion publishes the complete
   winning world and selected replay ancestry before retiring other worlds.
6. Outcomes from selected and discarded attempts can inform later decisions.
   Only the selected route contributes to main-run progress.

The core types are in [`contracts.ts`](../harness/src/contracts.ts). Doom composes
the workflow in [`session.ts`](../examples/doom/server/src/session.ts), and chess
in its own [`session.ts`](../examples/chess/session.ts). There is no universal
`createGame()` function that removes the need for this application composition.

## Background improvement

Cheap host checks detect repeated failures, stalls or changed objectives. They
coalesce observations and space reviews; healthy play does not require an LLM
review every turn. The supervisor receives observed results, current strategy and
game-specific mechanics. It proposes a versioned change rather than taking over
Jev's move selection.

The host validates a proposal, evaluates it against the current strategy, and
activates it only at a safe gameplay boundary with matching objective and revision.
Incomplete or stale evidence cannot qualify a change. Acceptance scenarios and
metrics stay outside the supervisor's control. Chess also runs regression audits
that can restore an earlier strategy while preserving the current board.

| Mutable surface | Doom | Chess automatic learning |
| --- | --- | --- |
| Strategy guidance | Revision prompts, skills and planner output | Preparation-source output |
| Available options | Validated generated multi-step plans plus host feasibility checks | Preparation can select/annotate supplied legal moves |
| Experience selection | Versioned preparation/retrieval | Preparation selects supplied evidence |
| Temporary goals | Validated targets, deadlines and observed completion | Validated targets, deadlines and observed completion |
| Search and recovery settings | Versioned policy; explicit user overrides remain authoritative | Pinned policy; automatic qualification currently covers source changes only |
| Motor behavior and scoring | Bounded execution/motor parameters and search reward weights | Engine rules and host evaluator remain fixed |
| Training curriculum | Optional retained observed checkpoints and public openings, separate practice recordings and later feedback | Optional selection from a host-frozen menu of observed practice positions; separate feedback and acceptance |

Doom and chess practice can inform a later supervisor review, but cannot qualify its own
candidate. Each uses separate run journals and receipts; the original acceptance
contract still runs unchanged. The generic core validates catalog/selection
identities while each application owns case creation and execution. Live
curriculum effectiveness remains unqualified.

This is not permission to rewrite every host value. Game mechanics, physical
runtime identities, canonical history and qualification rules remain host-owned.
Some Doom thresholds and execution algorithms are still fixed.

Supervisor CLIs run on the host with permission prompts bypassed, as configured
by these examples. Generated candidate code executes separately in restricted
VMs. Those are distinct execution boundaries. Generation usage is recorded without
a harness spending cap; finite evaluation and candidate-execution contracts still
apply. Older explicitly limited chess Jev configurations retain their saved limits.

## What a world means

| Capability | Doom | Chess |
| --- | --- | --- |
| Running state | Node-hosted WASM inside a detached microVM | Local chess.js engine reconstructed from initial position and full move history |
| Exact alternatives | Real game-VM snapshots and forks | Exact copies of board history, not VM forks |
| Execution checkpoints | Restorable VM state | Stored engine history |
| Recorded replay | Actual frames and matching observations | Recorded board positions/history |
| Background strategy execution | Separate executor VMs when using generated code | Separate executor VMs when learning is enabled |
| Browser disconnect | Backend continues playing | Backend continues playing |
| Backend shutdown | Game VMs remain detached; AI scheduling stops | Durable board history remains; play stops |

A recording is never an execution checkpoint. Detached Doom RAM does not survive
host shutdown. Missing selected VMs cause an explicit restore/startup error rather
than silently creating a replacement game.

## Persistence and ownership

Each backend owns one data directory. The optional local sessions manager creates
a versioned catalog with separate UUID directories, ports and private control
tokens. It starts detached hosts only on request and reconnects to them by token
after a manager restart. It can rename runs and request graceful host shutdown;
it never deletes game data or kills an unverified PID. Existing standalone commands
and their data formats remain unchanged. The gamepad menu links managed viewers
back to the catalog, or links configured backends for standalone viewers. See
[sessions](SESSIONS.md) for setup, ownership and evidence limits.

World journals retain physical identities and unfinished operations. Startup
reconciles interrupted input, fork, promotion and cleanup work before accepting new
inputs. Revision journals retain immutable artifact identities and activation
history. Changing code cannot silently replace a saved revision.

Doom uses a canonical-directory process lease. Chess uses an exclusive `.owner`
file shared by its web and CLI entries; an interrupted owner can leave that file
behind. These are single-host mechanisms, not distributed locks.

Selected Doom recordings are protected from discarded-footage GC until explicit
game restart. Completed chess games retain their selected replay. Losing VM cleanup
and recording retention are separate operations. The guides describe their reset
and recovery semantics.

## Reuse and verification

Start with [adapter requirements](../harness/ADAPTERS.md), including capability
declarations and cancellation/attachment responsibilities. A game without exact
state restoration can still support live decisions and recorded review, but cannot
claim exact alternative futures. Structured observations and legal controls require
an adapter; an arbitrary game's URL alone is not an integration.

See [verification](../VERIFICATION.md) for checks and evidence limits, and the
[completion checklist](../COMPLETION-CHECKLIST.md) for unfinished work. The older
[design plan](../GAMEPLAY-HARNESS.md) describes intent and milestones, not a current
implementation contract.
