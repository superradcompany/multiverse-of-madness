# Doom background learning

This is the current integration guide. The [historical learning report](../../../docs/history/doom-learning-2026-09-19.md)
preserves milestone details and original evidence paths. Start with the
[Doom user guide](../README.md) or [architecture](../../../docs/ARCHITECTURE.md)
for the overall flow.

## How a change reaches gameplay

1. `DoomLearningService` attaches to the game-aware session. It adopts an
   unsupervised session at a safe boundary, using its settings as the baseline.
   Saved learning sessions reconnect to their original binding.
2. Deterministic observation detects a changed goal, missing planner coverage,
   repeated failed outcomes or stalled selected-route progress. Reviews are
   coalesced; a timer alone does not trigger another generation call.
3. A durable job captures evidence and, when applicable, an execution checkpoint
   from the actual incident. The supervisor receives current strategy, guide,
   enabled user skills, statistics, failed plans, measured attempts and a bounded
   trace of the latest consumed Jev request. Private acceptance states stay hidden.
4. Codex or Claude proposes guidance, policy or preparation source. Host schemas,
   content hashes and supported-provider checks validate the result.
5. An owned background evaluator compares baseline and candidate on matched cases,
   including the retained situation when required. It measures full selected-path
   progress and all attempted work. Incomplete futures do not count as success.
6. A qualified change activates only at a safe boundary whose objective and
   revision still match. Rejection, cancellation or stale evidence retains the
   current strategy. Jev uses the active revision on subsequent decisions.

The current Doom review detector enforces at least two wall-clock minutes between
reviews. Reviewing the same issue again requires five wall-clock minutes plus
fresh evidence: 60 more selected game seconds while stalled, at least three new
failed outcomes across 60 attempted game seconds, or 12 new failed plans. The
latter paths cover rejected futures and plans that fail before advancing the game.
Consumed counters persist across restart; elapsed time alone does not repeat a
review. The latest issue determines whether conditional play needs new plans.
These are scheduling rules, not promises that every failure will be diagnosed or
resolved. Goal edits are coalesced, and failed proposals remain in the history.

## What the supervisor may change

The [policy schema](src/doom-policy.ts) covers fork threshold/breadth, trial and
decision duration, planning mode, winner delay, memory, recovery, search reward
weights, and bounded execution/motor settings. Explicit user edits apply after
revision policy; the user's maximum futures is a ceiling on learned breadth.

Execution policy also accepts optional `navigationAlignmentDegrees` (1–20,
default 7) for non-combat facing and interaction, and `movementAlignmentDegrees`
(1–90, default 25) for turning before advancing toward a target. Combat facing
continues to use the motor's aim tolerance. These settings are pinned to each
decision and used in live and evaluation sessions. Smaller values can increase
turning time; improvement must be demonstrated by comparison, not assumed.
Omitting them preserves historical policy contents and behavior. Older hosts
reject policies containing the new fields; saved supervised sessions require
the explicit gameplay-build upgrade before using them.

Preparation source can generate validated plan candidates, select supplied
history/experience and provide guidance. Candidate menus allow up to ten plans;
menu size and parallel future count are separate. The host retains legal controls,
geometry checks and input dispatch. Arbitrary generated code never runs inside the
application process.

`doom-preparation/2` may propose a temporary goal with a target and bounded lifetime.
The host binds it to the run, map, user objective, strategy and simulation clock,
and checks completion from engine observations. Repeated keys do not renew expired
goals. The user's objective is never replaced by an inferred key or route.

The model registry permits supported validated model/executor identities, not
arbitrary replacement of host services. Acceptance cases, acceptance metrics,
canonical history and VM ownership are not mutable. Training curriculum selection
and some strategic/execution algorithms remain unfinished. Exposed settings and
passing fixtures do not by themselves prove supervisor-driven improvement.

## Execution, usage and cancellation

New generation defaults to Codex CLI; Playback settings can select Claude for
future requests. The provider is pinned in each job. Repeating an existing job ID
cannot switch providers or silently repeat a completed invocation.

These CLI calls bypass permission prompts and run on the host. Generated candidate
TypeScript executes through the [isolated Microsandbox provider](../../../packages/executor-microsandbox/README.md),
with disabled networking, bounded resources/output and owned cleanup. Do not
confuse the CLI's host permissions with the candidate VM's restrictions.

Live Jev/planner usage and new supervisor generation are recorded without harness
spending/call caps. Historical limited ledgers remain evidence and are not reset
to hide usage. Evaluation runs and isolated code execution retain finite contracts,
deadlines and cancellation. Codex token reports are not dollar invoices; absent
usage is unknown, not zero.

Production evaluation uses an owned separate process. Live gameplay does not wait
for an entire proposal or comparison to finish. Nevertheless, CPU/memory contention
can affect throughput, and Jev/preparation latency can pause a world at a decision
boundary. Loser cleanup is owned in the background after automatic promotion;
pause, rollback and the next fork join it. A cleanup failure retains exact runtime
identities for reconciliation rather than accumulating new batches.

## Persistence and recovery

Learning lives under the session's `learning/` directory. A manifest pins the
runtime image, evaluation contract and gameplay build. Revision, job, source,
provider and executor journals preserve provenance. Explicit build upgrades create
separate lineages rather than rewriting old qualifications.

Startup reconciles interrupted jobs and unfinished executor ownership before
admitting new work. It does not rerun an uncertain paid request automatically.
Incident snapshots remain retained while referenced; recovery and collection use
their recorded runtime identities. A hash identifies content, not proof that a
strategy is safe or effective.

Comparison recordings are separate from the live run. New completed runs retain
the committed route for replay; discarded paths can be collected. Interrupted
recording recovery reads the saved committed world, retains its durable frame
prefix and reports missing tail footage. It never invents frames or a completed
qualification. Older comparison runs without recordings cannot be replayed as video.

## Gameplay build upgrades

A changed gameplay fingerprint refuses reopen. UI-only changes are excluded, but
matching source is not enough if required dependencies or runtime identities differ.
To perform the explicit handoff, first pause the old host at a resolved AI decision
boundary, settle plans/comparisons/evaluations, and stop its server. Build the new
checkout, then run from its root:

```sh
node --import tsx scripts/upgrade-gameplay-build.ts .data
```

Replace `.data` with the actual session directory. The command takes its lease,
verifies retained history, saves a backup of `session.json`, creates a new learning
lineage and publishes the binding last. Board/game state, recordings and previous
provenance remain intact. The carried strategy becomes a new baseline; its old
qualification is not transferred to the new build. This is maintenance, not an
automatic fallback for any startup error.

## Observe and diagnose

The brain button shows background status, recent changes and recorded comparisons.
**Available plans** and the guidance panel expose what the current strategy supplies
to Jev. The guide editor remains the user's objective.

The backend exposes `/api/learning/status` for the small normal-play status,
`/api/learning` for diagnostics, and proposal/evaluation detail routes. Diagnostic
proposal/test/activation commands still exist, but are not required for normal
background learning. They are local APIs, not a hosted authorization layer.

[Performance notes](../../../PERFORMANCE.md) distinguish simulation throughput,
frame delivery, decision/preparation waits and browser presentation. The read-only
supervisor analyzer accepts a learning directory:

```sh
node --import tsx scripts/analyze-supervisor-history.ts .data/learning
```

It reports historical receipts and sample coverage, without exposing prompts or
changing sessions. Byte reduction is not a measured token, latency or quality gain.
See [verification](../../../VERIFICATION.md) for commands that create actual VMs or
call models and for the remaining live qualification gaps.
