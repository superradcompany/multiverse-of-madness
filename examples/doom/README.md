# Doom: Multiverse of Madness

Jev chooses executable plans. The backend forks a running Doom game into alternate
futures, compares their measured outcomes, and continues from the selected world.
Doom WASM runs in Node.js inside detached microVMs; the browser is a viewer.

## Run

From the repository root, after `npm ci` and setting `TYPESAFE_API_KEY` in `.env`:

```sh
npm run demo:doom
```

Open <http://localhost:4317>. The command downloads verified engine assets and the
bundled Microsandbox runtime, builds the application, and starts the backend.
New and reconnected sessions start paused. Requires Node.js 24+ and a supported
VM host; the demo has been exercised on Apple Silicon macOS. Linux with KVM still
needs qualification for the complete workflow.

The default game-aware profile initializes background learning automatically.
Authenticate Codex CLI first, or pause background self-learning in Playback
settings. Claude CLI is selectable there. These supervisor processes bypass
permission prompts; see their [execution boundary](../../docs/ARCHITECTURE.md#background-improvement).
Jev remains the move-selection provider.

The server binds to loopback and is intended for local, single-user use.
Credentials stay in the server environment, outside browser bundles and game VMs.

## Follow the game

- **Resume AI play / Pause session** controls the backend loop. Pause joins
  dispatched inputs; closing the browser does not pause it.
- The futures grid compares plans from one starting state. The recent winner is
  highlighted. Layout controls select columns and optional scrolling for extra
  futures; clicking a card opens that world.
- **Why this choice?** explains routing and preferences. Confidence measures
  preference concentration, not survival probability.
- **Available plans** shows executable choices and changes. **Guide the AI** is
  your primary objective; supervisor guidance and temporary goals are advisory.
- **Run performance** shows progress along the selected route. Attempt statistics
  also include discarded experiments, so they should not be read as main-run kills.
- **AI skills** stores reusable instructions for Jev. These are prompt context,
  not plugins or model training. Enabled instructions apply to future decisions.
- The brain button opens background-learning activity and comparisons. Normal
  operation does not require manual proposal, test or activation commands.

The supervisor may optionally choose up to two public opening exercises to test a
specific uncertainty. The comparison viewer labels these **Practice** and retains
their replays. Practice results inform a later review; they never approve a change.
The saved incident and private regression tests still decide activation. These
opening exercises do not reproduce every later room or demonstrate stronger play.

Practice uses the existing background evaluator process with separate run journals
and allowances. Omitting it adds no practice runs. New proposal records use format
2; format-1 records remain readable unchanged, while older hosts refuse format 2.
Use the explicit gameplay-build upgrade workflow for a saved supervised session.
The integration has controlled local test coverage; live supervisor/VM curriculum
qualification remains pending.

The main world can remain paused while futures explore. A card saying
**choosing next approach** is waiting for Jev's next decision; it is not the winner
scoring operation. Automatic promotion publishes the winner before cleaning up
losers in the background. Decision prefetch can reduce subsequent waits, but does
not guarantee uninterrupted video or eliminate model latency.

## Tune exploration

Playback settings separates these controls:

| Control | Meaning |
| --- | --- |
| Maximum futures per decision | User resource ceiling, 2–10. The supervisor may choose fewer; the actual batch also depends on valid plans. |
| Fork below | Confidence threshold, 0–100%. Stalled progress and manual exploration can trigger comparisons independently. |
| Compare futures after | Game-time trial duration, normally six seconds. Applies to the next batch. |
| Ask Jev again after | Decision interval for either planning mode; can match the trial duration. Plans may finish or interrupt sooner. |
| Continue with winner after | Optional review delay, default zero. |
| Decision style | Short conditional plans or single actions. |
| Remember up to / use per decision | Retained attempts and the maximum relevant subset supplied per judgment. |

Doom runs at 35 game ticks per second. A six-second trial may include several
Jev decisions; it is not one input held for six seconds. Plans recheck observed
threats, targets and blocked movement while executing. Their routes are not
proven globally shortest paths, and speculative trials do not guarantee full health.

Enable **Use past attempts in decisions** to supply retrieved experience. Turning
it off still records outcomes. Clearing memories leaves replay footage intact.
Your explicit settings remain authoritative over learned policy, with the future
count acting as a cap. Larger parallel batches consume more memory and model calls.

## Replay, checkpoints and restart

**Replay full session** follows selected ancestry, including the winner's complete
trial and excluding discarded siblings. Choose a world or endpoint, seek, change
speed, or play from the start to a selected moment. Watching replay does not alter
live gameplay. The download control exports available footage as a silent H.264
MP4 using local ffmpeg; no upload is involved.

Execution checkpoints support rollback. They are separate from recordings:
watching an old frame does not restore the game. Checkpoint and recovery controls
are in the sidebar. Root disk maintenance compacts sealed layers before capture
when the inspected layer count reaches 64; failed compaction stops capture and
reports the error instead of continuing with uncertain disk state.

**Restart game** asks for confirmation, starts a fresh paused game and clears this
run's recordings and remembered attempts. The objective and user skill library
are preserved. It is not a way to replay an earlier checkpoint.

Selected recordings and their ancestors are retained until explicit restart.
Discarded recordings default to a 1 GiB, 24-hour, 200-world cache. Active trials
remain protected until selection. Retained paths can exceed the discarded cache
budget. Missing or previously deleted footage is reported, not reconstructed.

New supervisor comparison runs also record their selected gameplay routes.
The comparison viewer supports playback and seeking after a run. Interrupted-run
recovery preserves the durable recorded prefix and marks it partial; it does not
turn an incomplete evaluation into a successful one. Historical runs without
recordings remain unavailable. This newer path has offline lifecycle/browser
checks; a real-runtime replay soak remains outstanding.

## Persistence and separate sessions

| Setting or path | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `4317` |
| `MOM_DATA_DIR` | Independent session directory, default `.data` |
| `JEV_PROFILE` | `game-aware` by default; `baseline` retains the older controller without automatic supervision |
| `RECORDING_MAX_MB`, `RECORDING_MAX_HOURS`, `RECORDING_MAX_WORLDS` | Discarded-footage limits |
| `.runtime/` | Bundled runtime binaries |
| `MSB_HOME` | VM state; defaults to `~/.mom-runtime` to keep socket paths short |

For another run, choose both a new port and a new data directory:

```sh
PORT=4318 MOM_DATA_DIR=.data-second npm run demo:doom
```

The server claims its HTTP port and canonical-directory lease before opening
session state. A second owner is refused. Session data includes world identities,
settings, checkpoints, recordings and learning journals. VM data is separate.
`MSB_PATH` and `MSB_LIBKRUNFW_PATH` can override the bundled runtime locations.

Backend restart reconnects the selected detached VM and starts paused. Detached
RAM does not survive host shutdown; a missing/stopped selected VM produces an
explicit error instead of an automatic fresh game. Failed VM deletions remain
journaled for retry. Do not delete shared snapshot ancestors to silence a cleanup
error; snapshot references belong to the runtime and checkpoint lifecycle.

The gamepad menu switches between existing backends and preserves each run's
history. It does not launch servers or create sessions. Configure additional
links using the [shared session menu](../../docs/SESSIONS.md).

## Sound

The speaker enables the locally generated **Parallel Afterglow** score and event
sounds. Preferences and volume survive refresh, and the tab retains its score
position. Browser autoplay policy may require a click to resume audio; the button
then says **Resume sounds**. Hidden tabs suspend audio. Record the browser's audio
output for a demo video; stored gameplay recordings and MP4 exports have no music.

## Upgrades and diagnostics

A supervised session pins its gameplay build. If changed source prevents reopen,
use the [explicit build handoff](server/DOOM-LEARNING.md#gameplay-build-upgrades);
do not bypass the identity check or delete its learning history.

See [background learning](server/DOOM-LEARNING.md) for supported changes and
[verification](../../VERIFICATION.md) for offline checks and real-runtime commands.
The [historical report](../../docs/history/doom-example-2026-09-19.md) preserves
prior measurements and artifact paths. It is not the current setup guide.

The example demonstrates experimentation and recovery. Competitive Doom scores,
reliable autonomous escape from every stuck room, and sustained smooth playback
under background evaluation are not yet established.
