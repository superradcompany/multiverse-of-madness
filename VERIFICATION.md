# core implementation verification

Checked on Apple Silicon macOS, 2026-09-17. This covers the working tree,
not a published release. The reviewed prototype is preserved in commit `928da2e`.

| Requirement | Evidence |
| --- | --- |
| Standalone worktree outside microsandbox | `git worktree list` identifies the dedicated `multiverse-of-madness` repository and `demo` worktree. |
| TypeScript application | Server, browser, shared contracts, bridge, and setup/smoke tooling are TypeScript; the third-party Doom engine is WASM. `npm run typecheck` passes. |
| Real engine inside detached sandboxes | `npm run smoke:sandbox` creates actual VMs, compares matching initial states, advances distinct inputs, and checks differing states and PNG frames. |
| Fork isolation and continuation | The same smoke confirms the source remains unchanged and a child continues another 35 ticks. |
| Real Jev decisions from telemetry | `npm run smoke:session` uses the real service and engine observations to create two trials. The telemetry test verifies projectile geometry; the input-budget test verifies bounded entity lists and history. |
| Refresh/backend reconnect persistence | The two-process session smoke exits the creating process and reconnects to identical engine states, retaining the objective and starting paused. |
| One authoritative main world | Unit tests and the real session smoke verify promotion leaves exactly one main. |
| Human takeover | Real session smoke sends human input after promotion. Unit tests cover delayed inference fencing, pending branch operations, pause/resume, and explicit choice after intervention. |
| Objective steering | Session smoke queues an objective and checks it survives process restart. The live page exposes the direction composer. |
| Understandable comparisons | Unit tests verify comparison holds and retained outcome identities. Live DOM shows main/future roles, controllers, trial duration and health/progress differences. |
| Live viewer and previews | Browser check loads six real 320x200 images successfully, including the focused view and world cards. |
| Viewport layout | Browser document and viewport both measure 1456x902, with no page overflow. |
| Commentary and controls | Live browser exposes commentary, collapse/history controls, follow-main, pause/resume, archive, takeover, fullscreen and sound controls. Drag/resize persistence and volume are implemented in the browser source. |
| Credential boundaries | `.env`, runtime data and session checkpoints are ignored. The browser uses the local backend; VM deployment copies only the game bridge and engine assets. |
| Build and regression checks | Type checking, all 21 tests, production build, VM fork smoke, and real two-process session smoke pass. |

The existing application session remained paused with the same main and exact
world states throughout the final smoke checks. Smoke worlds are separate and
are cleaned up by the scripts.

## Performance evidence and limits

`artifacts/frame-benchmark.json` records four worlds producing 70 frames each,
at approximately 34.3 backend frame updates per second per world. This is a
local measurement, not a browser FPS guarantee or cross-platform benchmark.

The demo performs bounded action search with heuristic outcome scoring. It does
not establish that branching outperforms Jev alone, guarantee full health, or
reliably finish a level. No comparative efficacy benchmark has been claimed.

Detached VMs survive browser and backend exits, not host reboot. Durable reboot
recovery and hosted multi-user operation are outside this implementation.
Gameplay audio is not streamed; the UI provides optional synthesized cues.


## uncertainty and recorded multi-step continuations

The decision panel now exposes the actual distribution, confidence threshold,
routing mode, measured decision latency and counters. Boundary tests cover direct,
uncertain and manual decisions, including persistence of their evidence.

New live trials use 210 ticks with a fresh Jev action every 35 ticks. The real
browser trial produced four 211-frame recordings spanning ticks 10115–10325;
inspection verified the opening action followed by subsequent independent choices.
The chosen world retained tick 10325, health 39, and three total kills. Replay showed
the earlier state without rewinding the running world. Existing older worlds only
have the retained final frame.

Recording tests cover persisted matching frames/states, segment boundaries,
invalid indices, and storage-limit reporting. The two-process real session smoke
now covers multi-step continuations and replay records surviving process exit.
See ROUTING-EVALUATION.md for the small matched-start policy comparison and limits.


Recording retention now collects old inactive worlds and old segments automatically,
with a rolling window for active recordings under byte pressure. Tests verify
stable frame IDs, byte bounds, active-world protection under age/count retention,
and restart after collection. VM cleanup only retries previously journaled loser
identities; recording retention never calls the VM destruction API.

The final retention-enabled backend restart preserved the exact main and world
states, reopened 49 recorded worlds, and resumed the previously running AI loop.


## optional experience memory

The real Jev smoke call supplied one measured wait-action outcome and received
`experienceUsed: 1` from the application adapter with a valid model decision.
The real two-process session smoke retained enabled memory and its exact records
across host exit. Tests cover discarded-future memory, context filtering, bounded
retention, disabling and clearing. The browser exposes the toggle, and the
memory-enabled backend restart preserved the exact game states. This verifies
integration, not improved gameplay or weight training.

## Restart, retained paths, and configurable review delay

- Typecheck, production build, and 29 tests pass. New tests cover ancestry joins,
  cutoff ticks, duplicate checkpoint suppression, retention across age/byte/count
  cleanup and reconnect, explicit clearing, failed replacement creation, interrupted
  reset recovery, and changing an active winner countdown to zero.
- The real VM session smoke test now verifies stitched replay from tick 35 through
  112, followed by a fresh generation-zero VM at tick 35 with 100 health. Only its
  isolated smoke recordings were cleared.
- Browser check: two-world full-path replay stopped at tick 140 / 3.0 seconds after
  selecting “play from start to here”; 70 playback samples had no hidden or
  undecoded frame. Restart confirmation was inspected and cancelled. Playback
  settings showed “immediately” as its default; the desktop viewport did not scroll.
- Selected ancestry is now retained until explicit restart. Earlier notes about
  rolling eviction of active recordings describe the previous policy. Footage
  already deleted under that policy cannot be recovered.

## Steady director grid and decision cadence

31 tests, typecheck, build, and the real VM session smoke pass. Added coverage verifies
that changing the decision interval reaches the model adapter, clips the final action
to the trial horizon, persists across restore, and rejects invalid ticks. Director
world IDs stay unchanged through selection, deciding, and forking until a new batch
is ready. Browser inspection confirmed four panes, six interval choices with the
35-tick default, and no desktop page overflow.

At inspection, the live run showed 37 uncertainty forks, zero direct decisions,
20% Jev confidence, and a top action preference of 30%. Confidence is passed through
from the SDK; TypeSafe's live confidence documentation describes distribution
concentration, not gameplay success probability. No routing threshold was changed.

## Configurable trial duration and game-aware calibration

- Typecheck and production build pass. All 41 tests pass, including fixed/dynamic
  geometry distinctions, firing suppression, human-control bypass, cancellation
  during control resolution, unavailable fork candidates, and prior-action context.
- The real two-process VM smoke passes with game-aware controls: forks, detached
  reconnect, winner promotion, per-tick selected-path recordings from 35 through
  105 followed by human input to 112, and isolated fresh-game restart.
- Two smoke invocations accidentally overlapped during a failed test-harness run;
  their shared fixture caused a reconnect assertion failure. The final isolated
  rerun passed. Known leftover VMs from that invocation were destroyed by exact
  recorded name and identity; live user worlds were preserved.
- Actual Jev/engine evaluation: 651 requests in the corrected held-out comparison,
  all reporting `jev-1.13.0`. The exact-death-stop protocol and deterministic replay
  audit supersede the initial coarse evaluation. See CALIBRATION.md for full
  numbers, the survival tradeoff, and two future-comparison diagnostic cases.
- The production backend reload preserved every active world's exact observed
  game state and all timing settings, then resumed the previously running session.
  No game restart or recording reset occurred.
- Browser: connected live session uses game-aware perception. Expanded preferences
  displayed 11 geometry-blocked enemies, forward barrier distance, and the moving
  door limitation. Document and viewport both measured 1618×940: no page overflow.
- Trial-length UI provides 1, 2, 3, 6, 10, 15, 30 and 60 game seconds. Existing runs
  retain the duration captured for their batch; subsequent batches use the setting.

## Recovery checkpoints and run statistics (2026-09-17)

- `npm run typecheck`, `npm test` (50 tests), and `npm run build` passed.
- `npm run smoke:session` passed with real Jev, two detached VM experiments, process-exit reconnect, promotion, retained replay ancestry, human control and fresh-game reset.
- `node --import tsx scripts/checkpoint-smoke.ts capture` then `restore` passed in separate host processes. Captured two real full VM snapshots; moved beyond both; reconnected; restored the earlier exact GameState into a new detached VM; removed the newer checkpoint; resumed different inputs; verified replay ticks `[35, 36]` exclude the abandoned later path. Smoke-owned VMs and snapshots were removed. The first test run expected a seven-tick human input, but this script uses the Session default of one tick; the assertion was corrected and the isolated two-process check rerun successfully.
- Focused tests cover retry budget exhaustion, varied candidate sets, healthy-future selection ahead of unacceptable kill trades, selected versus all-world totals, map-counter resets, non-novel routes, three-checkpoint retention, restart cleanup, failed/interrupted restore, interrupted capture cleanup, and experience retention.
- Production backend reloaded and reconnected to the user's existing detached sandboxes. Exact active GameStates, main ID, objective, decision interval (14 ticks), trial length (35 ticks), and winner delay matched before/after. Previously running play was resumed. Automatic recovery remains off until selected.
- Browser verification: the new sidebar stats and expandable checkpoint panel render. At a 1618×940 viewport, document size remains 1618×940 and the fixed player ends at y=920. Existing page draft text was preserved by opening a separate preview tab instead of refreshing that tab.
- No matched gameplay evaluation of the new recovery thresholds was run. VM lifecycle correctness and policy unit tests do not establish a higher win rate. See OUTCOME-PLAN.md for the next controlled comparisons and benchmark caveats.

## Visible cumulative performance (2026-09-17)

Moved the main-timeline totals from the scrollable sidebar into a fixed run-performance strip above the game. It shows cumulative kills/items/secrets/exits, current health/armor, and tracked game time, independent of the focused future or replay. Partial historical coverage is visible beside the run label. Remaining details and checkpoint controls stay in the sidebar without duplicate headline metrics. No action-set or backend lifecycle changes.

Typecheck, build and all 50 existing tests passed. Browser verification showed the live strip and no document overflow at 1820×1127; the game remained within the viewport (bottom y=1107.5). Existing game continued without a backend restart.

## Long-running root disk layer limit (2026-09-17)

The user's live generation-250 main failed its next branch with `runtime-owned root-disk state has invalid identity or bounds`. Its `runtime/root-disk.json` contained exactly 256 layers. The runtime's validation limits root layers to 256; the attempted rollover would exceed the bound. A supported root-only compaction dry-run reported 256 input layers, 255 sealed selected, and 2 output layers. Diagnostic session/journal copies and repair results are retained under `.data/diagnostics/root-disk-limit/`.

Added adapter preflight before both `branchMany` and full snapshot capture: inspect with the SDK's `compact({rootDiskOnly:true,dryRun:true})`, then compact at 64 layers. Failures propagate and prevent capture; no disk metadata edits, runtime rebuild, or game reset. New unit tests cover the threshold, root-only scope, and stopping on adoption failure.

Live repair used the same maintenance helper on the exact existing sandbox identity (`local:4485`). Verified a 256-to-2 layer reduction and deep equality of the complete GameState and PNG before/after. Then branched the formerly failing source into two real test VMs, checked both initial states, advanced one child, and verified the source unchanged. Only test children were destroyed. The latest pre-repair full checkpoint also restored into a separate test VM with exact tick 8750 and health 52; that test VM was removed, leaving the snapshot intact.

Typecheck, build and 52 tests passed. The two-process real Jev/VM session smoke passed again. Production backend reconnected to the same main and retains both recovery checkpoints and the user's enabled recovery settings. Play is left paused for review.

## Snapshot ancestry cleanup fix (2026-09-17)

Previous assumptions about separate groups were wrong: full snapshot lineage crosses group boundaries. Restart queued older parents first and hit Microsandbox's indexed-child deletion guard. Added ancestry-aware collection over the actual snapshot index, removing only queued leaves before parents, using exact artifact references and never force. Ancestors of retained/external children stay queued; missing artifacts are acknowledged idempotently. Cleanup calls are serialized. Corrected snapshot retention wording: three selectable checkpoints can require more ancestor artifacts.

Typecheck, build and 56 tests passed. `node --import tsx scripts/checkpoint-gc-smoke.ts` passed with real VMs and four cross-group full snapshots: fourth capture evicts the first selectable point while retaining its ancestor artifact; restart deletes the complete chain child-first and creates a healthy fresh game. Test VMs and snapshots were cleaned.

Reloaded the production backend. Its pending old-checkpoint chain and already-journaled obsolete sandbox cleanup completed. Verified old snapshot references are absent, both cleanup queues are empty, and the API has no current error. The before/after identity assertion could not establish unchanged state because a new game was started and advanced during verification; the latest live session was running with new generations and a saved checkpoint. We did not reset the production game or use force deletion. Diagnostic before/after session files are under `.data/diagnostics/checkpoint-gc/`.

## Kill-counter audit and trial reset correction (2026-09-17)

Confirmed the pinned engine's player ABI reads `killcount` at byte offset 28, populated directly from `viewplayer->killcount`. Doom's `P_KillMobj` increments it for MF_COUNTKILL monsters, including non-player-caused deaths in single-player. It is not a count of every destroyed object or proof of player-shot accuracy.

`node --import tsx scripts/calibration/audit-kills.ts` replayed all 12 frozen baseline/game-aware held-out runs using the same inputs, reading independent engine death events every tick. All 10 monster death events matched counter increments exactly (10 player-caused in this sample); every recorded decision state was reproduced. This is real WASM execution on the host, not a VM test. Output: `artifacts/kill-audit/engine-events.json`.

`node --import tsx scripts/calibration/audit-recorded-kills.ts` audited 2,395 frames of the live selected route to tick 2429. Three counter increments at ticks 453, 1193 and 1451 matched both engine map kills and the displayed main total of 3. The all-worlds total was 7 and includes discarded futures. Output: `artifacts/kill-audit/live-recording.json`. No lost kills were observed in this route; this does not identify an unspecified visual incident from another route.

Found and corrected a separate cross-level bug: trial kills and experience outcomes previously subtracted raw map counters, so a map reset could produce negative or lost trial credit. Trials now accumulate per-step cumulative counter increases and reconnect reconciles any unpersisted increment. Experience counter changes also account for map resets. A regression test starts with five old-map kills, gets one next-map kill, and verifies trial=1, promoted run total=6, and remembered outcome=1.

Future panes/cards now show map kills plus additional kills this trial. Main performance details explicitly explain selection, rollback and engine kill semantics. Typecheck, build and 57 tests passed. Reloaded the backend, but the before/after comparison could not verify preservation: the session identity changed to a fresh run during verification. The comparison stopped before automatically resuming. Subsequent live state shows gameplay and rollback activity with no API error; current user-controlled play/pause state was left unchanged.

## Immediate obstacle recovery (2026-09-17)

The old motor controller adjusted aim every tick but did not steer around collisions. Jev received static center-ray distances at decision boundaries; these could miss the player's footprint or dynamic obstructions. A live stuck state also showed a 16-unit forward barrier while executing `turn left and move`, confirming that excluding straight advance alone did not resolve the motor behavior.

Added a per-world local recovery controller: conservative player-footprint clearance, seven consecutive low-displacement ticks to detect unmapped collisions, a committed escape heading, temporary avoidance of failed headings, and pulsed use attempts. It resumes the requested movement after clearing the immediate obstacle. Intentional idle and human controls remain explicit; aim assistance cannot cancel a recovery turn. Recovery memory is copied into futures and checkpoints and persisted across backend reconnects. Commentary identifies these as movement-controller interventions rather than Jev decisions. Jev also receives footprint clearance; failed movement no longer offers idle as a candidate. No engine state writes or teleportation.

`node --import tsx scripts/calibration/obstacle-recovery.ts` drove the real WASM engine into 32 blocked starts with four movement directions and eight orientations, then compared identical starts. Legacy aiming-only control moved at least 64 units within three seconds in 2/32 cases; recovery did so in 32/32, at most 55 ticks (1.57 seconds). With geometry deliberately hidden, recovery passed 32/32, at most 74 ticks (2.12 seconds). An initial hidden-geometry version failed six cases; adding failed-heading memory resolved those fixtures. These are targeted development fixtures, not held-out evidence of overall game completion or globally shortest routes. Artifact: `artifacts/obstacle-recovery/engine.json`.

`node --import tsx scripts/obstacle-smoke.ts` passed with two actual VM forks from a blocked state. Both modes escaped that transient obstruction (legacy 44 ticks, recovery 40); source GameState and PNG remained identical, and test VMs were destroyed. The first assertion incorrectly required the old controller to remain blocked and was removed: dynamic obstructions can clear without navigation. Artifact: `artifacts/obstacle-recovery/vm.json`.

Typecheck, build and 62 tests passed. `npm run smoke:session` passed with real Jev, detached VM forks, cross-process reconnect (including motor memory), selected replay stitching, promotion, human input and test-only restart. Historical calibration replay audits retain the old motor controller; new game-aware evaluations write separate `validated-navigation` and `policy-navigation` directories.

Reloaded the live backend and verified exact active GameStates and cumulative statistics against the paused snapshot, then resumed the previously running session. No production game reset. Diagnostics: `.data/diagnostics/obstacle-recovery/`.

## Conditional two-/three-step plans (2026-09-17)

Added code-built plan candidates ranked through Jev Choice, per-tick condition-based execution, guarded replanning and a selectable legacy single-action mode. The comparison horizon remains fixed while plans can complete and be replaced inside it. Direct plans use the same configured horizon. Guarded inputs retain the existing motor controller; waypoint turns do not accidentally lock onto an unrelated enemy. Plans are journaled with world/checkpoint state and pending forks; manual takeover cancels plan execution. Recorded frames include plan name, step and completion/interruption status.

69 unit tests pass, plus typecheck and the web/bridge build. New tests cover condition-driven step transitions, damage/timeout/map/horizon interruption, target loss and occlusion, exhausted ammunition, feasible health candidates, a two-future trial spanning multiple legacy action intervals with one initial judgment, final-frame plan metadata, and pausing/reconnecting a direct plan without another judgment. Existing tests cover cancellation and human control arbitration.

`npm run smoke:session` passed with actual Jev plan selection and two detached VM futures. Verified saved/restored plan and motor memory, full state equality across host exit, promotion, selected replay stitching, human input, and a fresh test-only restart. These checks establish integration and lifecycle behavior, not improved win rate or fewer model calls across representative game runs.

Reloaded the production backend with exact active GameState and cumulative-stat equality against its paused snapshot, then resumed its previously running session. The existing two-second trial duration was preserved. Live API and browser accessibility inspection showed Plan preferences and step 2/2 progress, with no API error. UI copy distinguishes plans from single actions and keeps the page's existing fixed layout. Diagnostics: `.data/diagnostics/conditional-plans/`.

The production run subsequently ended at zero health (it had two health at rollout; automatic recovery was disabled). It remains paused with recordings retained. Reloaded the final status-copy correction while paused and verified unchanged main identity/statistics and no API error; no restart/reset of the game was performed.

## Fresh decision context, configurable memory and stalled progress (2026-09-17)

Production action and plan requests now share fresh current-state and inherited-route statistics, the active guide and bounded relevant attempts across every question, including priority. The session regenerates answers if the guide changes in flight and invalidates old plans. The decision panel exposes the supplied guide/statistics and actual memory count. Added persistent confidence (0–100%), retained-attempt (8–1,024) and per-decision memory (1–8) controls; defaults remain 75%, 128 and 2. Learning remains opt-in.

Movement through visited space no longer earns outcome-score credit. Candidate exploration uses visited cells and a bounded frontier route, and ten game seconds without useful progress triggers an explicitly labelled comparison even above the confidence threshold. Nearby distinct same-type enemies no longer cause the entire combat candidate to be excluded. Static-route and actor-identity uncertainty remain; these changes have not been shown to improve representative completion rates.

Typecheck, build and 76 tests passed. New tests cover all question envelopes, max memory bounds, persistence and threshold routing, guide changes during future judgments, automatic stalled-progress comparison, old-space movement scoring, frontier routing, and grouped enemy targeting. The real Jev detached-VM session smoke passed: two experiments, cross-process reconnect, selected replay stitching, promotion, manual input and test-only restart.

`node --env-file=.env --import tsx scripts/calibration/guide.ts` passed on three frozen game states with both combat and health candidates. Holding each state fixed, combat and recovery guides produced the expected plan and priority in 6/6 real Jev judgments. The API also accepted a 1,000-character guide and all eight supplied memories. Artifact: `artifacts/guide/paired.json`. This is a targeted guide-sensitivity check, not a gameplay benchmark or guarantee of instruction compliance.

Reloaded the backend and confirmed live decisions include the new statistics/guide evidence and controls. The production game advanced and promoted a future during verification, so the paused-state equality assertion did not establish preservation across the reload. No production reset was requested or performed; no automatic resume was issued after that mismatch. Subsequent API/browser inspection showed the existing run actively progressing, the new decision-context panel and no API error. Diagnostics: `.data/diagnostics/decision-context/`.

## Per-decision AI skill library (2026-09-17)

Added a session-wide registry and browser dialog for named instruction skills: create/edit/delete, enable/disable, and import short Markdown/text files. The backend validates unique names, IDs, count and input budget before any mutation. Limits: 32 stored skills, 2,000 characters each, 2,400 serialized characters enabled. All enabled instructions are appended in full to every production Jev request alongside guide/stats, including priority and future continuation questions. The guide has precedence; skills do not execute code or fetch linked files. Decision evidence retains exact names/instructions supplied.

Enabled-skill edits discard stale in-flight judgments and invalidate running plans, including older plans restored from checkpoints and plans created by an in-flight fork. Library settings survive host reconnect, game restart and rollback. Disabled-only edits do not invalidate gameplay. Existing journals without a registry restore an empty library.

Typecheck, build and 87 tests passed. Tests cover all action/plan request envelopes, disabled exclusion, atomic budget/name validation, skill replacement during a future/root judgment, reconnect/restart preservation, deletion and old-plan invalidation. `scripts/skills-smoke.ts` passed with real Jev in action and plan modes using the full 2,400-character skill budget, 1,000-character guide and all eight memories. Artifact: `artifacts/skills/context-budget.json`. `npm run smoke:session` passed with a real enabled skill reaching Jev, detached VM forks, reconnect, replay stitching, human control and skill retention through test-only restart.

Browser verification created a disabled temporary skill, refreshed, verified saved instructions, edited and deleted it. The page still fits its viewport; the dialog scrolls internally. Inspected the rendered editor screenshot. No sample skills were left enabled or stored in the production library.

Reloaded the production backend and verified exact active GameStates, main identity, cumulative stats and guide against the paused snapshot, then resumed the previously running session. No game reset. Diagnostics: `.data/diagnostics/skills/`.

## Adaptive original music (2026-09-17)

Added “Parallel Afterglow”, an original 104 BPM D-minor electronic score synthesized in the browser. A 16-bar chord progression carries pads, syncopated bass, percussion, delay and sparse melodic phrases. Nearby threats/low health add rhythmic detail; paused gameplay retains quiet ambience, and replay playback controls musical activity independently. Replaced commentary-per-message beeps with rate-limited fork/winner cues. Master mute/volume remain beside Pause, with separate music/effects switches in Playback settings. Preferences persist locally; audio starts only after the speaker is clicked. Hidden tabs fade and suspend; one audio clock survives React/game-state updates and the context closes on unmount.

Typecheck and production build passed. Browser verification exercised speaker enable, fade/mute to a suspended context, re-enable using the same single context, separate music/effects switches, preference persistence on reload and muted startup. An OfflineAudioContext rendered the complete 16-bar phrase plus decay (40 seconds, stereo, 22,050 Hz), transitioning from calm to danger intensity. Output was finite, peak 0.1292 and RMS 0.0160 on the inspected left channel at default gain, with zero remaining source voices after rendering. This checks signal generation/headroom and cleanup, not subjective listening quality. No external sample assets, dependencies, credentials or audio services were added. No backend restart or game-state changes were needed.

## Key-door loop correction

- Typecheck, production build, 93 unit/regression tests and engine smoke passed.
- Real `smoke:session` passed: Jev decision, detached VM forks, process reconnect,
  winner promotion, selected-path replay and isolated restart.
- Forked the live stuck E1M2 sandbox into a disposable probe. Upgraded its wrapper
  in place with identical pre-existing observations and framebuffer. The probe
  had no key. Over 2052 controlled ticks, the new progression route moved from
  (1207.98, -207.67, -8) to (924.49, -1012.03, 24), with health unchanged at 92.
  This exercised the real VM/engine and deterministic route controller, not Jev
  selection. Probe evidence is `artifacts/stalled/progression-probe.json`; the
  disposable sandbox was destroyed afterward.
- A separate real Jev request against the captured stuck observation selected
  `key-route` (54% preference, 8% confidence). These are distinct model outputs;
  neither is a measured success probability.
- Upgraded all five active live sandboxes and reloaded the backend. Every old
  observation was preserved, including main tick 38976. The live run subsequently
  reached (936.89, -1223.98, 24), health 92, while pursuing the red-key objective.
- Browser showed the active goal and key inventory, no error alert, and no page
  overflow. The navigation objective is code-generated and explicitly labelled.
- Not established: complete level/run success, optimal routes, high model accuracy,
  or a real-engine full key-acquisition/return/unlock sequence. The latter workflow
  has regression coverage with synthetic observations, not a completed live run.

## Remove the imposed key strategy

This supersedes the strategic policy in the preceding key-door experiment.
Removed automatic find-key/return-door objectives, prompt priority, reserved
comparison slots, route bonuses and recovery exemptions. Inventory, interaction
feedback, lock feasibility checks and the finer general exploration search remain.

- Typecheck, production build and 93 tests passed. Regressions cover no objective
  substitution, no implicit action-to-plan mode switch, Jev receiving lock facts
  without key instructions, and retirement of old strategy state on reconnect,
  interrupted-fork recovery and checkpoint rollback.
- Real detached sandbox session smoke passed (Jev, forks, reconnect, promotion,
  replay ancestry and isolated restart). A separate real Jev request against the
  captured stuck state selected `explore_0`; no forced key candidate was supplied.
- Reloaded the live backend. All five active game states and the user's current
  guide were identical across restart; old navigation goals and bonus fields were
  removed. Existing recordings were retained.
- This is removal of an imposed strategy, not implementation of the planned
  supervisor or evidence of a complete-game performance improvement.
