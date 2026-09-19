# Remaining live qualification

The combined offline build is qualified at source revision `b34ef0c` on Node
24.21.0 and 26.3.1. This runbook covers the remaining evidence, not completed runs.
Live qualification remains unverified on the combined build. Use dedicated test
resources; this plan does not require resuming the historical demos.

## Freeze the run

Record the Git revision, dependency lock, engine hashes, runtime version, model
configuration, initial state and user settings with each result. The local runtime
was inspected on 2026-09-19: `msb 0.7.1`, with the macOS hypervisor
entitlement. This is a preflight observation, not a successful VM startup.

Use a new qualification data directory and separate ports. Ordinary runtime tests
should use a fresh `MSB_HOME`; `scripts/runtime-env.ts` honors an explicitly supplied
value. Keep saved session files read-only. A retained incident snapshot belongs to
its original runtime store: do not assume it can be restored from the fresh one.
Before borrowing it, verify its physical identity and use only new child IDs.

Preserve the original observation capabilities. In particular, an older detached
bridge may not advertise weapon selection. Never label a restored old bridge as a
current one or substitute a fresh opening for the actual stuck position.

## Runtime checks before paid gameplay

From the repository root with runtime and image setup complete:

| Command | Required evidence | Scope limit |
| --- | --- | --- |
| `npm run smoke:sandbox` | Equal source/child engine state, divergent inputs and source preservation | Fork mechanics, not learned play |
| `npm run smoke:executor` | Candidate isolation, bounded output, cancellation, timeout and owned cleanup; creation/recovery journals settle | Generated code only; supervisor CLIs intentionally run on the host |
| `node --import tsx scripts/promotion-continuation-smoke.ts` | Winner advances seven ticks while loser deletion is held; exact winner identity survives | Deterministic overlap, not browser FPS |
| `npm run qualify:doom-revisions` | Isolated source activation, detached reconnect, exact rollback and selected replay | Hand-authored wait/advance programs, not autonomous improvement |
| `npm run qualify:executor` | Invalid candidate rejection, accepted candidate activation and revision rollback across chess host restarts | Fixed tactical cases, not ordinary chess strength |
| `node --import tsx scripts/incident-restore-smoke.ts /absolute/retained-session-directory` | Two restored runs match the borrowed checkpoint; new ticks are metered; descendants are removed and source retained | Existing checkpoint required; no supervisor or useful-plan claim |

The Doom revision script intentionally leaves its owned game VMs alive between
child processes. Do not interpret a stopped child process as completed cleanup. On any
failure, inspect its resource/session journals before another attempt; recover
only recorded IDs with matching physical identities. Do not use a global stop,
remove snapshots with descendants, or treat a cleanup exception as success.

## Acceptance runs

These checks need live observation and complete receipts. The existing short
smoke scripts do not automate or satisfy this whole table.

| Requirement | Run and evidence needed |
| --- | --- |
| Unattended stuck-room recovery | Restore an isolated child of the actual incident. Let normal play and automatic supervision detect the problem, propose options, evaluate and activate at a safe boundary. Capture the offered/selected plans, guide, revision identities, selected replay and observed escape or threat resolution. An extra visited cell alone is not proof of escaping the room. |
| Add/replace/remove plans and mutable settings | Retain the actual supervisor proposal, validation, paired results, activation and next consumed Jev request. Verify changed options, guidance, skills, context selection, policy and execution settings where used. Separate exposed-but-unused fields from demonstrated changes. Record unsupported execution changes rather than silently treating them as supported. |
| Independent improvement and regression handling | Compare supervisor-on/off from matching states and declared allowances. Keep all attempted work, failures and rejected trials in the report. Measure kills, survival, health, progress and completion across held-out starts. Demonstrate rejection and a regression rollback without resetting the selected game history. Do not tune acceptance rules from a candidate's results. |
| Token efficiency | Match request receipts to observation windows. Healthy/unchanged play must not repeatedly dispatch reviews. Verify the two-minute minimum and five-minute repeat cadence with fresh evidence, including rejected futures and zero-tick failures. Record actual input/output tokens and unknown usage separately. |
| Performance | Match simulation ticks, delivered frame versions, browser-painted frames, Jev waits, executor phases, fork/snapshot timing and persistence work over the same interval. Compare equal settings with supervision off/on and across future counts. Report distributions and workload, not just an average FPS. |
| Long-running cleanup and replay | Run gameplay with background evaluations through retries, cancellation, refresh and host reconnect. Account for every owned game/executor VM and snapshot descendant. Verify layer compaction, selected replay ancestry, retained checkpoints and eventual disposal of unreferenced footage/state. A cleanup failure must remain owned and retryable. |
| Managed sessions and viewer | Create separate Doom and chess runs through the manager. Change settings independently, play, refresh, stop/reopen and verify independent learning history and replays. Check main/winner/experiment labels, automatic guidance updates, replay seeking, restart/new-game and responsive layout. |

For delivery/decision instrumentation against an already running qualification
host, the existing read-only observer accepts a URL, duration and report path:

```sh
node --import tsx scripts/observe-live-performance.ts http://localhost:4317 60 /tmp/qualification-delivery.json
```

Use the qualification host's actual URL. Delivery gaps are not browser-painted
frames. Pair this report with browser measurements and the matching executor
journal as described in [performance](../PERFORMANCE.md).

## Finish and report

Pause and join the test hosts' work. Settle resource owners and verify that the
recorded test VMs are absent; confirm any borrowed snapshot is still present with
its original identity. Preserve receipts, selected recordings, errors and unresolved
cleanup journals. Stopping a backend alone does not destroy detached Doom VMs.

For each requirement, report passed, failed or unverified with its source revision
and evidence. Keep implementation gaps separate from missing live evidence. The
[completion checklist](../COMPLETION-CHECKLIST.md) remains open until both are
resolved. The offline suite, a fixture-generated proposal or one successful room
cannot substitute for the remaining acceptance runs.
