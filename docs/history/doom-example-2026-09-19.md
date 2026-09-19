> Historical snapshot, archived 2026-09-19 before documentation consolidation.
> Statements describe their original milestones and may be superseded. Use the
> [current architecture](../ARCHITECTURE.md) and [verification guide](../../VERIFICATION.md)
> for supported behavior and qualification limits. Report paths under `artifacts/`
> refer to local evidence, which is ignored by Git and is not bundled with this repository.

# multiverse of madness

A live TypeScript demo: Jev chooses actions, microsandbox forks the running Doom
engine into alternate futures, and the best observed outcome becomes the main run.
The browser is a viewer and controller. Doom WASM runs in Node.js inside each VM.

## Games and saved sessions

Use the gamepad button beside the title in either viewer to open **Games & sessions**.
The default links point to Doom on 4317 and chess on 4321. A session on a custom
port also appears as the current run. Switching changes the viewer only: each backend
keeps its own game state, settings, learning journal and selected replay. Running
games continue; pause a run first if you want it to stop while viewing another.
The selector does not start servers or create/reset sessions.

For different hosts, ports or session paths, set `GAME_SESSIONS_JSON` when building
the web app. It is a public array of `{id, game, gameLabel, title, description, url}`
objects, with unique IDs and absolute HTTP(S) URLs. Credentials are rejected and
must never be included. For example:

```sh
GAME_SESSIONS_JSON='[{"id":"doom","game":"doom","gameLabel":"Doom","title":"Main run","description":"Current Doom session","url":"http://localhost:4317/"},{"id":"chess","game":"chess","gameLabel":"Chess","title":"Chess run","description":"Current chess session","url":"http://localhost:4321/"}]' npm run build:web
```

Without an explicit catalog, loopback hosts use the local demo links above; other
hosts show only the current session. See [the chess guide](../../examples/chess/README.md)
for starting a separate chess or learning-enabled session. A shared session-creation
workflow and explicit transition of historical plain-Jev runs remain unfinished.

## Run

Run commands from the repository root.

Requires Node.js 24+, a TypeSafe API key, and a host that supports microsandbox.
The complete workflow has been exercised on Apple Silicon macOS. The runtime
installer also handles Linux arm64/x64; that platform has not been qualified here.

```sh
npm ci
cp .env.example .env
# Add TYPESAFE_API_KEY to .env. Keep this file private.
npm run demo:doom
```

Open http://localhost:4317. The first start downloads the Node container image and
creates a detached sandbox. Later starts reconnect to the saved session.

`npm run setup` downloads hash-verified engine assets and the microsandbox 0.7.1
runtime, then builds the bridge and React app. Runtime binaries live in `.runtime/`;
VM data defaults to `~/.mom-runtime` because macOS Unix socket paths must stay short.
This is separate from your normal microsandbox installation and its database.
Explicit `MSB_HOME`, `MSB_PATH`, and `MSB_LIBKRUNFW_PATH` environment overrides are
supported. Do not point this demo at unrelated production runtime state.

The web server binds to loopback. This is a local single-user demo, not a hosted
multi-user service. The backend reads `.env`; credentials never enter the browser
bundle or VM snapshot.

The server reserves its HTTP port and a local process lease before opening session
files. A second server using the same data directory is refused, including when
the directory is reached through a symlink. The kernel releases the lease after a
crash. Its loopback port is derived from the canonical directory; collisions with
an unrelated listener also refuse startup. This lease covers one host, not a
network-shared data directory. Stop older servers before upgrading: versions
without a data lease are detected only by a conflict on their HTTP port.

For a separate local session, set both `PORT` and `MOM_DATA_DIR`. The latter places
the session, VM settings, recordings and movie exports under that directory. With
no override the existing `.data` and `.cache/movie-exports` locations are preserved.

## Use

- **Resume** runs the AI loop. **Pause** waits for dispatched inputs to finish.
- **Explore next futures** runs one fork batch while paused. **Select best outcome**
  promotes the highest-scoring completed trial. Automatic play continues immediately
  by default. **Playback settings** sets the winner review delay from 0 to 60 seconds;
  changing it also updates an active countdown. The setting survives reconnects
  and game restarts. The latest alternatives stay visible until the next batch.
- **Playback settings → maximum futures per decision** selects 2–10 (default 4).
  The next batch tests up to that many valid plans in parallel; larger batches
  require more VM memory and model calls. The director shows all futures in a vertically scrolling grid. Its Grid selector
  chooses 1, 2 or 3 columns and remembers your layout.
  The setting survives reconnects and restarts.
- The decision panel shows confidence against the threshold. Expand action
  preferences to inspect the distribution; these are not survival probabilities.
- The player history icon opens recorded worlds. Scrub to a frame or play the
  recording, then return to live. Replay does not change the running simulation.
- The sidebar follows the view: decision/recovery controls beside the grid,
  focused progress and a compact world switcher for one world, and searchable
  recording history plus MP4 export during replay.
- Click a world to watch it. **Auto director** keeps the camera on the winner.
- **Take control** fences AI actions before accepting WASD, arrow keys, space, and E.
  Pause/resume also works during human control. **Return to AI** leaves play paused.
- **Continue from here** explicitly chooses a world. After manual intervention,
  automatic comparison stays disabled until you choose which world to continue.
- **Guide the AI** queues a new objective for the next decision. Shift+Enter adds a line.
- Drag, resize, or collapse commentary. Sound cues are opt-in; volume is adjustable.
- The archive icon reveals final frames from the last 20 archived worlds. Those VMs
  are released after a winner is chosen, so archived cards are view-only. The most
  recent alternatives remain visible even when older archives are hidden.

## Persistence

All VMs and their game-bridge processes run detached. Refreshing or closing the page
does not destroy the session. AI play continues while the backend is running.
Human input stops when its browser is hidden or disconnected.

The backend atomically saves the world tree, runtime identities, objective, trial
progress, and final frames to `.data/session.json`. On backend restart it reconnects
to those same VMs and reads their actual engine state, without replaying inputs.
Play starts paused, and previous browser control is released to AI. Interrupted
fork creation and unfinished loser cleanup are reconciled from the saved journal.
A replaced sandbox identity is rejected rather than silently opening a different run.

Detached VMs retain RAM across backend exits, not host shutdowns. Saved execution
checkpoints support explicit restoration into another sandbox. Startup still
requires the selected detached VM: missing or stopped VMs produce an explicit
error rather than silently replacing the session with a fresh game.

## Replay and movie export

Replay has play/pause, five-second skips, a game-time timeline, playback speed,
fullscreen, and a recording picker. With the player focused, Space/K toggles play
and arrow keys seek five seconds. Recording options include full ancestry or one
world, refresh, and playing/exporting from the start through the current point.
Replay and export do not alter the live simulation.

The download icon exports the full selected recording as an H.264 MP4. Wait for
encoding, then **Save MP4**. Export freezes the endpoint visible when requested;
refresh the recording first to include newly recorded gameplay. Footage follows
selected ancestry, holds sparse frames for their recorded game time, and exports
at original speed regardless of playback speed. Existing recordings have no
audio, so movies are silent. Missing history is disclosed before exporting only
the available footage.

`ffmpeg-static` supplies the local encoder. No upload is involved. Exports use
`.cache/movie-exports`, with one encoder job at a time and two encoding threads.
Cancel stops encoding and removes the partial movie. Unused outputs expire after
30 minutes, and backend startup/shutdown cleans temporary exports. Source
recordings are unchanged.

## Recorded gameplay

Frames and their matching full engine observations are recorded for every world
from the point recording is enabled, including trials that are later discarded.
Compressed segments live in `.data/recordings`, independently of VM cleanup and
session history. The player history icon lists all recorded worlds, including ones
no longer present among the latest 20 archived cards. Initial older worlds have
only their retained final frame; there is no reconstructed historical footage.

Selected futures and their ancestry are retained until an explicit **restart game**.
They are excluded from byte, age, and world-count garbage collection. Active trials
are also kept intact until selection. Retained footage can grow beyond the cache
budget; the budget applies to discarded alternatives only.

Discarded footage defaults to a 1 GiB cache, 24-hour age limit, and 200 recordings.
Set `RECORDING_MAX_MB`, `RECORDING_MAX_HOURS`, and `RECORDING_MAX_WORLDS` in `.env`
to change these bounds. Cleanup runs on startup, every 30 seconds, and before
segment writes. It only touches this demo's recordings. Segments flush every
second and on clean shutdown; a crash may lose the buffered second. Disk errors
stop recording with a visible warning.

Use the header replay icon for the full path to the current main session. The
endpoint selector also supports the ancestry of another world. Playback joins at
fork game ticks, includes the chosen future's complete trial, and does not repeat
the shared checkpoint frame or include discarded siblings. Scrub to a moment and
choose **play from start to here** to stop there; **refresh recording** captures a
new endpoint. **This world only** limits playback to one world's own footage.
Earlier footage already deleted by the previous retention policy cannot be
recovered; incomplete paths show a warning.

**Restart game** asks for confirmation before ending this run, deleting its
recordings (including retained paths), and clearing learned attempts. A fresh VM
is created and committed before old VMs are released. Cleanup intent is persisted
so interrupted recording cleanup completes when the backend starts again. The
new game starts paused at generation zero; the objective, assets, credentials,
and unrelated sandboxes are preserved.

Losing VMs are destroyed after selection; failed deletions are journaled and
retried automatically when idle. The checkpoint retains at most 20 archived
worlds and 100 commentary events. Active VM identities are never selected for
recording cleanup. Replay is view-only, not an executable snapshot or
rollback. Live gameplay continues independently while watching a recording.

The main player shows total level kills. Trial cards show **new kills** since that
trial began, which can be zero even when the ongoing run has already killed enemies.

## Optional experience memory

Enable **learn from attempts** above the direction composer to pass relevant past
outcomes to Jev. The controller records observed action durations, health/ammo/kill
changes, movement and deaths from both the main run and discarded futures. This
bounded memory lives in the host session checkpoint, outside the cloned VMs, and
survives backend restarts and deletion of losing worlds. **Playback settings →
remember up to** sets retention to 8–1,024 attempts (default 128); recording-file
retention is independent of experience retention. Reducing capacity drops the oldest attempts.

**Use per decision** sets a limit of 1–8 nearby attempts (default 2), filtered by map, position,
heading, height, health, ammo availability and nearest-enemy context. Retrieval
includes conflicting outcomes for the leading matched action when available.
The decision panel shows how many measured observations actually fit and were supplied. These remain
observations, not universal rules or generated explanations. Missing line of sight,
geometry differences and timing can still make a nearby attempt irrelevant.

The option defaults off. Turning it off stops supplying memory on subsequent
requests while continuing to record outcomes; **clear** forgets the current memory
without deleting gameplay recordings. Changes cannot retract an inference already
in flight. New observed attempts can accumulate immediately after clearing.

The request budget is capped by dropping experience entries if needed. This is
context supplied to the model, not model-weight training. The real Jev smoke test
checks consumption of measured experience; it does not establish improved play.
The routing evaluation below tests branching and is not a memory on/off benchmark.

## Routing evaluation

`npm run evaluate:routing` compares Jev alone, the 0.75 uncertainty gate, and always
branching from three identical-per-policy starting states. Results are written to
`artifacts/routing-evaluation.json`, with health, kills, displacement, game ticks,
simulation ticks across all worlds, wall time, model confidence and errors.

This is a small exploratory test, not a calibrated threshold or survival benchmark.
It gives every policy six one-second decision rounds; the short 35-tick trials
isolate routing cost and differ from the live six-second multi-step lookahead.
Exclude incomplete runs from outcome comparisons. Displacement is not proof of
progress toward the exit; simulation ticks are a compute proxy, not billed CPU.

## How it works

- `examples/doom/web`: React viewer, live previews, commentary, controls, and direction input.
- `examples/doom/server`: authoritative session lifecycle, Jev decisions, scoring, persistence.
- `examples/doom/contracts`: shared TypeScript state and input contracts.
- `examples/doom/bridge`: TypeScript HTTP bridge around the freestanding Doom WASM.
- `design/`: the original reviewed, simulated prototype, preserved for reference.

The bridge has no autonomous game timer. The orchestrator advances bounded batches
of one game tick, so capture happens between input batches. A fork batch uses
`branchMany` to capture the same VM once. Each world uses a persistent agent relay for inputs and frames. Relays are closed
before capture and reconnected in each child; inherited host connections are not required.

Jev receives engine telemetry, not screenshots: resources, nearby enemies, projectiles
and pickups, relative bearings/heights, and recent-action feedback. The game-aware
profile adds static WAD geometry checks and filters obstructed choices. Static checks
do not establish complete current visibility through moving doors/lifts, projectile
ownership, or collision predictions. The original baseline input remains available
for comparisons.

A Choice question ranks actions; a second independent Choice interprets the objective
as survival, exploration, or combat. Below the demo's 0.75 confidence threshold,
up to four highest-ranked available opening actions are tested for equal horizons, defaulting
to 210 ticks (six game seconds). By default each child asks Jev for a fresh action every 35 ticks after
its opening move; trials do not recursively fork. This threshold
is a tunable demo policy, not a validated optimal Jev operating point.

Outcome scoring uses observed survival, level transitions, health, kills, resources,
and displacement, weighted by objective. Displacement is a progress heuristic;
it is not a path planner or proof of progress toward the exit. Commentary describes
those application events, not private model reasoning. The current controller is
not qualified to reliably finish a level.

Frames are PNGs produced inside each sandbox. WebSocket events notify the browser
of updated frame URLs. The loop targets the engine’s native 35 ticks per second and subtracts processing
time from its frame interval. Before recording was enabled, a local four-world test measured about 34–35 frame
updates per second per world at the backend; browser delivery and other hosts can
vary. Inference, capture, and the deliberate comparison hold still pause game time. Doom gameplay audio is not streamed;
the UI has synthesized interaction cues.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run smoke:engine
npm run smoke:sandbox
npm run smoke:jev
node --env-file=.env --import tsx scripts/session-smoke.ts create
node --env-file=.env --import tsx scripts/session-smoke.ts reconnect
```

The sandbox smoke test proves identical initial engine state, divergent child
positions and frames, an unchanged source, and continued play in a child.
The two-process session smoke test uses real Jev and real VMs, persists the complete
session, exits the host process, reconnects, promotes a winner, and tests takeover.
Smoke VMs are destroyed after successful completion; the application VMs remain
available across server shutdowns by design.

The TypeSafe skill is installed at `.agents/skills/typesafe-ai/SKILL.md` and its
source revision is recorded in `skills-lock.json`. See `assets/README.md` for engine
provenance, checksums, and licenses. All application and tooling source is TypeScript;
the third-party Doom engine remains compiled WebAssembly.

### Automatic director

Enable **auto director** in the header to watch futures side by side. After selection,
the winner stays highlighted in its existing pane and the other outcomes remain
visible while the next decision and fork are prepared. A complete new batch replaces
the panes together. Click any pane to inspect it at full size; **resume auto director**
returns to the grid. Before the first fork, the main world fills the player.

In **Playback settings → ask Jev every**, select 0.2, 0.4, 1, 2, 3, or 6 game seconds
(7–210 ticks). The default remains 1 second. The separate **compare futures after** setting controls the trial length. Settings apply after an in-flight action; the final action is
clipped to the remaining trial time. Jev receives the actual planned duration.
Longer intervals reduce inference pauses but react less often. The interval persists
across reconnects and restarts.

Jev confidence is the SDK's distribution-concentration statistic, not survival odds.
The 75% fork threshold is experimental and has not been calibrated for this game.
Several plausible actions or missing information can spread the action distribution.

Replay keeps the last decoded frame visible while loading and prefetches the next frame. Futures advance independently within the same game-time horizon: a slow model response no longer blocks siblings. Each future still pauses at its action boundary until its fresh decision arrives, shown as **choosing next action…**; this is real inference time, not an extra one-second timer. Pause and takeover still wait for all already-dispatched operations.

In **Playback settings → compare futures after**, choose 1, 2, 3, 6, 10, 15, 30, or 60 game seconds. The default is 6 seconds. The new duration applies to the next batch; running and recovered trials retain their captured horizon. This setting persists across reconnects and game restarts, independently of the Jev decision interval and winner review delay.

### Game-aware Jev controller

The default `JEV_PROFILE=game-aware` supplies static map barriers, occluded targets, relative heights, semantic resources and recent-action feedback to Jev. It filters known-obstructed choices and uses a TypeScript motor controller to check firing/aim each tick. Human takeover uses raw controls. Targets across potentially moving door/lift sectors remain uncertain; this is not engine-exact line of sight. Existing detached worlds and recordings stay intact; older bridges report an unknown weapon until a fresh game is created.

Use `JEV_PROFILE=baseline` to reproduce the original controller. See [CALIBRATION.md](../../CALIBRATION.md) for the matched evaluations, failed experiments, exact limitations, and reproduction commands. The improvement reduces wasted firing and wall-sticking; it has not demonstrated reliable level completion or calibrated survival probabilities.

### Recovery and run statistics

The fixed **run performance** strip above the game shows the main run's cumulative kills, items, secrets and level exits, plus current health/armor and selected game time. These values stay tied to the main run when inspecting a future or replay. Expand **performance details** in the sidebar for ammunition, damage/healing, areas visited, and total simulated work across all worlds. Selected totals are inherited by forks and only the chosen child's totals become main. They accumulate across map counter resets. Rollback restores those totals without counting abandoned kills twice; attempt counters and experience remain. Existing runs without historical counters are marked partial: their current-map kills are included, but time/damage/attempt tracking starts at this upgrade. “Areas” are 128×128×32 spatial cells, not solved routes. Damage and ammunition totals are observed state deltas, not engine event logs; a pickup and expenditure within the same observed tick can cancel out.

Expand **checkpoints → save checkpoint** to pause and capture the main sandbox's full execution state. **Restore** creates a fresh detached VM from that snapshot, archives the current branch, and pauses for review. The restored replay follows the checkpoint's original route up to its capture tick, then the new branch. Previous selected footage stays available. Checkpoints survive browser/backend restarts; they are full VM snapshots, not screenshots or input replays. The latest three stay selectable; older ancestor artifacts remain while indexed descendants still exist. Separate groups do not remove snapshot ancestry. Eviction, explicit deletion, rollback to an older checkpoint (which removes newer checkpoint targets), and game restart queue owned snapshot artifacts for cleanup. Cleanup follows indexed ancestry, removing children before parents and deferring ancestors of retained snapshots without forcing deletion. Selected recordings remain pinned until an explicit game restart.

**Automatically recover poor runs** is opt-in. Defaults when enabled:

- Two retries after the initial poor batch, then restore the latest checkpoint and pause.
- Reject dead futures, a health loss of 15 or more from the checkpoint or trial start (whichever was healthier, within the same map), or 15 game seconds without a new cell, kill, item, secret or health gain.
- Acceptable futures rank before unacceptable ones. Novel cells add a small exploration bonus; repeated corridors earn no novelty bonus.
- Retrying keeps the unchanged source and rotates opening candidates when the available action set permits. Enable **learn from attempts** to send relevant measured failures to Jev; rollback itself never clears that memory.
- Save an initial checkpoint on the next AI cycle, then healthy progress milestones at least 30 selected game seconds apart. A milestone requires health at least 40 and no lower than the previous checkpoint, plus a kill, level exit or four new cells. A dead main from direct AI play restores immediately because it cannot continue its trial.

The retry budget counts comparison batches, not model calls or individual futures. Human promotion overrides the automatic policy. Restoring pauses deliberately so an unchanged policy cannot silently retry forever. This is a configurable recovery heuristic, not evidence of an optimal route or higher win rate. These new thresholds have not yet been benchmarked against held-out runs.

```sh
# Real snapshot capture, host-process exit, reconnect, rollback and replay validation.
node --import tsx scripts/checkpoint-smoke.ts capture
node --import tsx scripts/checkpoint-smoke.ts restore
```

Before each fork or full checkpoint, the VM adapter checks the root disk's physical layer count. At 64 layers it uses the runtime's supported root-only compaction to merge sealed layers before capturing again. This prevents long-running sessions from reaching the runtime's 256-layer bound. Compaction preserves guest memory, the writable head, and existing snapshots. It can briefly pause VM execution; a compaction failure stops capture and surfaces the runtime error instead of blindly retrying a possibly incomplete disk switch.

Future panes show **map kills** (the engine's current-level total) and **+N this trial** separately. The fixed performance strip follows the selected run across maps; kills in an unselected future do not increase it. Doom's level kill counter counts eligible monsters, can include monster infighting, and does not count every destructible object. Trial and experience deltas account for map resets. Kill audits can be reproduced with `node --import tsx scripts/calibration/audit-kills.ts` (requires frozen calibration artifacts) and `node --import tsx scripts/calibration/audit-recorded-kills.ts` (requires the live app with complete selected-route recordings).

AI movement now has local obstacle recovery on every game tick: it checks clearance around the player's footprint, detects seven failed movement ticks (0.2 game seconds), and commits to an escape turn before moving again. Recent failed directions are temporarily avoided; use is pulsed to retry nearby doors. The commentary identifies movement-controller interventions. This assistance operates independently of the Jev decision interval and is copied with each future/checkpoint. Human inputs bypass it. It handles immediate collisions, not globally shortest routes or guaranteed level completion.

Reproduce the focused engine comparison with `node --import tsx scripts/calibration/obstacle-recovery.ts` and the real VM fork check with `node --import tsx scripts/obstacle-smoke.ts`. Current game-aware calibration results use separate `artifacts/calibration/validated-navigation` and `artifacts/calibration/policy-navigation` directories; earlier performance numbers describe the prior controller.

### Conditional plans

The default **short conditional plans** mode asks Jev to choose among code-built, observation-grounded plans with two or three steps: explore new space, collect health/resources/keys, engage or strafe an enemy, approach supported doors/switches/exits, withdraw toward cover, work around an obstruction, or return toward a remembered pickup. Candidate menus are bounded and favor distinct goal families before extra variants. Jev supplies plan preferences; the backend advances steps on observed alignment, arrival or target outcomes, with bounded step times. This is a small library of local plans, not free-form model-generated routes or a globally optimal planner.

Every future retains the configured comparison duration. Completing or invalidating a plan early asks Jev for another plan using the remaining budget; it never resets that future's comparison clock. Direct execution uses the same duration as its maximum plan budget. Significant damage, a new nearby enemy, lost/ambiguous/occluded targets, ammunition exhaustion, blocked progress and timeouts can interrupt a plan. Collision recovery still runs each tick. Target matching is conservative because the current engine observations do not expose stable actor IDs.

Plan names and step progress appear in the futures, focused view and recordings. Pausing/reconnecting preserves the plan cursor and deadlines; takeover clears the plan and gives raw inputs to the human. Checkpoints retain plan execution state. **Playback settings → decision style → single actions** restores the previous decision loop; its configurable action interval remains available. Mode changes apply at the next decision, and current trials keep their captured duration.

Plan confidence describes concentration among the available plans, not calibrated survival probability. The existing fork threshold has not been recalibrated for this mode. New plan-policy evaluation output goes to `artifacts/calibration/policy-plans`, separate from prior action/controller evidence.

## Decision context and progress

Every production Jev request shares the active user guide and fresh, world-specific statistics across all its questions, including the priority judgment. These include health, armor, weapon and all ammo types; map kills/items/secrets; inherited route totals, damage/healing, explored cells and game time; and time without a kill or useful progress. Discarded siblings do not inflate that world's totals. Expand **Context sent to Jev** in the decision panel to inspect the guide and a summary of the supplied statistics.

The guide is explicitly the primary objective. Changing it interrupts old plans at the next control boundary; responses produced against an outdated guide are discarded and requested again before execution. This gives the guide priority in the prompt, not guaranteed model compliance. A request to avoid all damage can legitimately conflict with aggressive combat; enemy health and game mechanics cannot guarantee one-shot kills.

**Playback settings → fork below** adjusts the confidence gate from 0–100% (default 75%). It persists across reconnects and restarts. Manual comparisons and ten game seconds without useful progress bypass this gate; the decision panel labels each reason. Confidence measures preference concentration, not success probability.

Exploration candidates prefer unvisited cells and can include a bounded route back through known corridors toward new space. Outcome scoring rewards newly visited cells instead of distance travelled through old space. The local route uses static geometry and per-tick movement guards, so it is not a guaranteed or globally shortest path. These changes discourage circling; they do not establish a competitive Doom score.

`node --env-file=.env --import tsx scripts/calibration/guide.ts` compares combat and health-recovery guides on identical frozen engine observations and exercises the long-guide/eight-memory API budget. Requires the calibration artifacts under `artifacts/calibration/validated`; writes `artifacts/guide/paired.json`. It does not modify the live game.

### Gameplay tuning and generic harness

[GAMEPLAY-HARNESS.md](../../GAMEPLAY-HARNESS.md) maps the performance controls, current defaults, plan capabilities, observation/scoring gaps, and proposed game-adapter boundary. It distinguishes existing runtime settings from code defaults and future interfaces. Use it to choose what to tune and how to evaluate the result.

## AI skill library

Click **AI skills** above **guide the AI**, then **Add skill**. Give the skill a name and reusable gameplay instructions, or import a short Markdown/text file. Save it enabled to apply it at the next Jev decision. Edit, disable or delete skills from the same dialog. Up to 32 skills can be stored, with 2,000 characters per skill and a shared 2,400-character JSON budget for enabled skills. Oversized changes are rejected atomically; enabled instructions are never silently truncated. Unused skills can remain stored and disabled.

Every main-world and future-world question, including priority, receives all enabled skills. The active user guide takes priority over conflicting skills, and game mechanics still constrain available actions. This is prompt context, not model training or a plugin that runs scripts. Markdown links and supporting files are not fetched. Names and exact instructions supplied to the root decision appear under **Context sent to Jev**.

Skills are session-wide and persist in the host journal across refreshes, backend reconnects, game restarts and rollback. Changing enabled instructions invalidates old plans and in-flight judgments before their next decision is executed. Editing a disabled skill does not interrupt gameplay. Resetting the game clears recordings and remembered attempts but preserves the skill library.

API commands: `skill-save` with optional existing UUID `id`, `name`, `instructions`, `enabled`; `skill-toggle` with `id`, `enabled`; `skill-delete` with `id`. Omit `id` when creating a skill. A missing update/delete target produces an explicit error. `node --env-file=.env --import tsx scripts/skills-smoke.ts` verifies real Jev requests with the full enabled-skill budget, a 1,000-character guide and eight memories in both action and plan modes.

## Adaptive soundtrack

Click the speaker beside Pause to enable **Parallel Afterglow**, an original 104 BPM electronic score generated locally with Web Audio. Layered chords, bass, percussion and melody evolve over a 16-bar progression; danger adds rhythmic detail and pausing settles into ambience. Replay playback drives its own musical activity. Fork/winner cues replace the previous per-commentary beeps.

The existing volume slider controls the mix. **Playback settings → soundtrack** independently enables music and event sounds. Those preferences and volume persist locally; each page load starts muted until a user enables audio. Hidden tabs fade out and suspend the audio context. Music uses no external recordings, downloads, account or API key, and is not embedded into stored gameplay frames. To capture it in a demo video, record the browser's audio output.

### Key and door observations

The bridge reads card/skull inventory and recent locked-door, key, switch,
platform, and door events from the pinned engine ABI. Jev receives inventory,
recent interactions and nearby map lock requirements as facts; moving openings
remain explicitly unknown. Key observations also have a separate list so nearer
items cannot displace them from the pickup limit.

Approaching a locked door does not assign a goal. The user guide remains the
objective, and Jev ranks ordinary feasible plans, including observed key pickups,
exploration, combat and interactions. There is no forced key route, reserved
comparison slot, key-specific score bonus or recovery exemption. The finer route
search and floor tracking serve ordinary exploration. Static geometry still
cannot guarantee the state of moving doors, lifts or actors.

Saved experimental key strategies are retired on reconnect, including recovery
points and interrupted forks. Existing game state, guide and recordings remain.
A configurable supervisor that can diagnose stalls and propose temporary goals
is planned in [GAMEPLAY-HARNESS.md](../../GAMEPLAY-HARNESS.md#extraction-sequence-and-later-supervision);
it is not implemented by this correction.

Older detached bridges and checkpoints are upgraded on reconnect without restarting
WASM: a guest-local inspector replaces only the engine wrapper, verifies every
existing observation and the framebuffer, then closes the inspector. A failed
verification restores the old wrapper and reports an error. Build before starting
so `dist/engine.mjs` is available. Existing gameplay and recordings are preserved.

### VM resources

The server icon opens resource settings for the main world or any resident future, plus defaults for new games. CPU, memory, root disk size and boot-time ceilings are configurable. New defaults persist in `.data/vm-settings.json` and apply on game restart; forks and checkpoint restores inherit their source configuration.

Pause before previewing or applying a per-world override. The backend uses the Microsandbox modification planner with `no_restart`; unsupported or restart-required changes are displayed without applying them. CPU/memory acceptance is distinct from actual convergence, which the result displays. The bundled runtime may not support live CPU/memory resizing. Use new-game defaults and Restart game for those changes.

Optional session CPU and memory budgets count the source plus all resident futures. A batch that would exceed either budget is refused before branching. Zero disables the harness budget, not the host's resource limits. Resource totals are configured allocations, not measured usage. The future count is a maximum; fewer valid plans produce fewer sandboxes, and the grid displays the actual count alongside the decision's captured limit.

Restored snapshots may omit the original root-disk size in their config. The VM panel labels this as retained checkpoint capacity; leaving that field blank preserves the disk. CPU/memory inspection and planning remain available without inventing a disk size.


### Headless harness comparison

After the normal asset/dependency setup and TypeSafe credentials, run:

```sh
npm run evaluate:harness -- --simulation-ticks=560 --model-calls=4 --scenarios=0 --candidate-threshold=1
```

This compares direct play against confidence-triggered futures using the real
Doom engine and current session implementation. Each run receives the same total
game-tick and model-call caps. Discarded futures and replay reconstruction count
against the budget. Input/output tokens are recorded from Jev but are not capped.
The clones use deterministic input replay, so this is not a VM-fork benchmark.

A new directory under `artifacts/harness-evaluation/` contains the manifest,
source snapshots, build hashes, per-run budget journals, observations, decisions,
saved sessions and comparison. Existing output directories are refused. The
included scenarios are diagnostic starts used previously, not new held-out
acceptance cases. A passing illustrative score would not establish broad gameplay
improvement. The live app's sandboxes and saved session are not used or changed.

To qualify an isolated search-policy proposal through the supervisor controller:

```sh
npm run evaluate:harness -- --supervise --simulation-ticks=560 --model-calls=4 --scenarios=0 --candidate-threshold=1
```

The output directory includes `supervisor.json` (proposals, evidence references and
activation history) and `active-profile.json`, verified after reopening the journal
from disk. A rejected candidate leaves the experiment's baseline active. This
command does not change the live game's settings. It currently qualifies policy
changes only. Executable isolation and continuing-session activation are qualified
in the chess example. Doom enables background learning automatically, with its status in the header and pause/provider controls in playback settings. The diagnostic scenarios/default provider model are not a held-out,
fully pinned acceptance benchmark.

Executable revision qualification is available with `npm run smoke:executor` and
`npm run qualify:executor`. See [the isolated provider](../../packages/executor-microsandbox/README.md)
and [the existing chess engine example](../../examples/chess/README.md) for the tested
scope and current limitations. The chess dependency is pinned to 1.4.0; these
commands do not change the live Doom game.

The second-game session is runnable headlessly:

```sh
npm run example:chess -- run --directory .data/chess-demo --cycles 4
npm run example:chess -- replay --directory .data/chess-demo --frame 2
```

It exercises the same shared workflow components with persistent chess worlds,
whole-future promotion, selected replay ancestry and rollback. The default model is
an explicit deterministic fixture. Add `--model jev` in a new directory for real
TypeSafe decisions with a durable API-call limit. See [the chess guide](../../examples/chess/README.md)
for continuation, guidance, configuration and runtime distinctions.

### Temporary goals

A supervisor-generated planner may return `doom-preparation/2` with a bounded
`temporaryGoal`. Jev receives active goal guidance alongside the unchanged user
objective. The host checks completion against engine state; a goal ends on death,
expiry, a changed objective/strategy or a different map. Missing key observations
are reported explicitly. Reusing a proposal key does not renew its deadline.
Goals appear in Available plans and follow forked worlds, recordings and saved
checkpoints. This adds no separate supervisor call on each turn.

Sessions containing goals use format 3. This build still reads formats 1 and 2;
older builds reject format 3, so keep the upgraded build when reopening such a
session. The live demo is not upgraded automatically by a source checkout.
These lifecycle checks do not establish that a proposed goal improves gameplay.
