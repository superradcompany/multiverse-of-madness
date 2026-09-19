# Verification and evidence

This page separates repeatable checks from historical demonstrations. It does not
claim that all commands below were rerun on the current revision. The
[completion checklist](COMPLETION-CHECKLIST.md) remains the scope of unfinished
work; green unit tests do not close live-runtime or gameplay-quality requirements.

## Offline checks

From the repository root:

```sh
npm run typecheck
npm test
npm run test:harness
npm run test:web
npm run build
```

The application suite includes controlled providers, filesystem/process lifecycle
tests and local-WASM checks. The core suite checks generic workflow contracts.
These do not establish real VM isolation, live model behavior, browser smoothness
or improved gameplay. Build/typecheck/test scripts that build the harness should
run sequentially so they do not write the same output concurrently.

For independent package consumption:

```sh
npm --prefix harness run check:package
```

That check builds a clean temporary package, installs its tarball into a separate
consumer, checks public types and exercises exported APIs. It may download npm
dependencies; it does not call a gameplay model or start game VMs.

## Checks that use real services

These commands require setup and may create VMs and/or make model calls. They are
not part of the offline suite. Read the script's inputs and ownership behavior
before running it, especially for commands that reconnect an existing session.

| Command or script | What it exercises | What it does not establish |
| --- | --- | --- |
| `npm run smoke:sandbox` | Real Doom fork isolation, distinct inputs, continuation and frames | Browser FPS or learned strategy quality |
| `npm run smoke:session` | Live Jev, persistent session creation/reconnect and selected continuation | Unattended long-run reliability |
| `npm run smoke:fork-recovery` | Real interrupted fork recovery | Every crash point or storage failure |
| `npm run smoke:executor` | Isolated TypeScript execution, cancellation, cleanup and recovery | Safety of unrestricted host supervisor CLIs |
| `npm run qualify:executor` | Revision evaluation, activation, reconnect and rollback on fixed chess cases | Chess playing strength |
| `npm run qualify:doom-revisions` | Doom revision/session wiring | Broad autonomous improvement |
| [`promotion-continuation-smoke.ts`](scripts/promotion-continuation-smoke.ts) | Winner movement while retired VM cleanup is held | A general latency or FPS improvement |
| [`decision-prefetch-smoke.ts`](scripts/decision-prefetch-smoke.ts) | Live speculative decision reuse and observed boundary waits | Elimination of all pauses |
| [`qualification/doom-goals.ts`](scripts/qualification/doom-goals.ts), [`qualification/chess-goals.ts`](scripts/qualification/chess-goals.ts) | Temporary-goal lifecycle with real providers | Useful autonomous goal selection |
| [`chess-strategy-evaluation.ts`](scripts/chess-strategy-evaluation.ts) | Paired saved-strategy evaluation, including the full-harness mode | General strength from a few sampled positions |

Commands starting models need the corresponding server-side credentials; executor
checks need the supported Microsandbox runtime. The examples' [run guides](README.md#try-it)
describe setup. A check that could not run is unverified, not passed.

## Current evidence boundaries

| Area | Evidence available | Remaining requirement |
| --- | --- | --- |
| Doom runtime and forks | Historical real-VM runs plus controlled lifecycle tests | Requalify current combined changes and sustained operation |
| Chess reuse | Real Jev games and learning/rollback runs recorded in history; exact board-history tests | Stronger play and broader held-out comparisons |
| Background learning | Durable job/revision tests, historical proposal/activation/rejection/audit runs | Reliable unattended recovery from actual persistent gameplay problems |
| Policy, motor behavior and temporary goals | Versioned contracts and targeted integration tests | Supervisor-driven use of every promised surface and measured outcome gains |
| Selected-path replay | Retention/stitching tests and historical viewer checks | Current cross-game restart/GC/replay soak |
| Doom evaluation recordings | Recorded-route, recovery and viewer fixture tests | Real VM comparison replay and interrupted-run soak on this implementation |
| Plain chess adoption | Offline startup, old-checkpoint, completed-game replay and publication-failure tests | Live Jev/VM adoption qualification |
| Training curriculum | Portable selection tests plus controlled chess and Doom practice/feedback/restart/cancellation; practice success cannot override failed acceptance; Doom observed-state retention/pinning and stale-selection IPC checks | Live supervisor-selected practice, archived-lineage checkpoint retirement and measured learning value |
| Shared sessions manager | Isolated-directory catalog tests, authenticated lifecycle tests, detached HTTP child reconnect/stop and browser form/responsive checks | Managed real-game start/reopen and independent replay/learning soak |
| Performance | Historical delivery/decision/executor measurements; read-only analyzers | Current causal attribution, browser frame measurements and matched before/after runs |
| Distribution | Clean package-consumer and root-workspace checks reported historically | Final clean checkout plus current cross-game/runtime acceptance |

A future's survival does not imply the same input sequence is optimal everywhere.
Relative improvement on a diagnostic scenario does not establish robust play.
Doom delivery versions are not browser-painted frames; chess exact board copies
are not VM forks. Missing usage is unknown, and CLI-reported dollars are not invoices.

## Historical reports

The original reports are preserved under [docs/history](docs/history/README.md).
Their dated commands, artifact paths and measurements describe those revisions;
they are not promises about the current checkout. Later entries can supersede
earlier ones, including old limits, UI names and planned-versus-implemented status.

`artifacts/` is ignored by Git. Reports that name it refer to locally retained
qualification output, not downloadable evidence bundled in this repository. If
those originals are unavailable, rerun the relevant check before relying on a
historical result. Never reconstruct missing footage or label fixtures as real VM
execution to fill an evidence gap.

For a new result, retain the commit/build and dependency identities, exact inputs
and contracts, baseline/candidate identities, complete outcomes including failures,
resource/usage coverage, and verified cleanup. Separate measured results from
hypotheses, pending checks and claims about gameplay quality.

See [PERFORMANCE.md](PERFORMANCE.md) for measurement methodology and
[harness/ADAPTERS.md](harness/ADAPTERS.md) for integration qualification requirements.
