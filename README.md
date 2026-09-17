# multiverse of madness

A Doom demo in which an AI explores alternate futures in independent microsandbox
branches and continues inside the selected world.

## Current status

`design/index.html` is the interactive design prototype. Open it directly in a
browser. `design/multiverse-player.html` is its editable source fragment.

The prototype uses illustrative frames, scripted outcomes, and browser-generated
sound cues. It does not run Doom, call Jev, or create real sandboxes. Keyboard
control only previews inputs. Submitted directions are displayed as queued but
are not applied to an AI.

## Implementation direction

Use TypeScript across the application:

- `apps/web`: React frontend, world previews, commentary, directions, and takeover.
- `apps/server`: Node.js orchestrator using the microsandbox TypeScript SDK.
- `packages/contracts`: shared session, action, event, and protocol types.
- `packages/game-bridge`: TypeScript bridge for game telemetry, frames, and inputs.

These are planned modules, not implemented yet. Doom remains a native engine;
validate its state/input interface before selecting an engine or promising that
no native bridge changes will be required.

The backend owns lifecycle and control arbitration. Keep Jev calls and credentials
outside the sandboxes. Run full branching on a supported local host. Use controlled
game ticks for comparable experiments; reconnect bridges after restoring or
branching rather than relying on inherited network connections.

Start with WebSocket session events and inputs plus a separate compressed-frame
stream. Measure latency and bandwidth before deciding whether to use WebRTC.

## Session model

Exactly one world is the main session. At an uncertain decision point, pause its
game progression, fork independent experiments, run equal game-time horizons, and
select an outcome using observed results. The chosen child becomes main. The old
main and unselected experiments become archived history.

Camera selection is independent from the main session and control ownership.
Every world displays its role (main, experiment, archived), state (running, paused,
ended), and controller (AI or human).

Taking control pauses automatic branching/selection and stops AI actions in the
chosen world before accepting user inputs. Returning to AI leaves the overall
experiment paused until explicitly resumed. “Continue from this world” explicitly
promotes an experiment to main. Archived worlds are view-only in this prototype.

## Accepted UI direction

- Dark purple theme, clean sans-serif fonts, subtle solid borders.
- Large focused player on the left; scrolling world previews on the right.
- Main-session card spans the sidebar; experiments use a two-column grid.
- Main controls: camera-follow first, then grouped playback and sound icons.
- Archive visibility uses an icon; no separate recent-forks timeline.
- Commentary is draggable, resizable, and collapsible; retain geometry on changes.
- Prompt composer is at the sidebar bottom, aligned with the focused player.
- Interface sounds are opt-in with volume control; no ElevenLabs integration yet.

## First technical milestone

1. Run one Doom process inside a microsandbox.
2. Branch it into two real sandbox children from one game moment.
3. Reconnect both bridges and apply different inputs.
4. Show independently diverging frames and state.
5. Continue from one child and release the unused world.

Then integrate Jev decisions, uncertainty-triggered exploration, takeover
arbitration, and the reviewed interface. No live runtime performance has been
validated by the design prototype.
