# Games and saved sessions

Each example backend owns one session directory. Switching pages leaves game
state, settings, learning history and replays with its backend. A playing run
continues; pause it first if you want it stopped.

## Create and manage runs

```sh
npm run demo:sessions
```

Open <http://localhost:4316>. This command sets up Doom assets/runtime and builds
both viewers, but does not start any game backend. **Create session** saves a
catalog entry; **Start backend** opens that run in a detached process. **Open game**
takes you to its viewer. Gameplay starts paused. Enabling chess background learning
requires the VM runtime and authenticated Codex CLI and can begin supervisor work
as soon as its backend starts. Enable Doom learning in its gameplay settings.

The manager supports creation, renaming, starting, reopening and graceful backend
stopping. Runs have distinct, stable ports and UUID directories under
`.data/sessions/runs/`. Each backend retains its own settings, learning files and
replays. Names are display labels, never filesystem paths. **Rename** does not move
or reset data. The gamepad menu in a managed viewer links back to this page.

Closing the page or manager leaves its backends running. Restarting the manager
with the same directory and port reconnects by a private per-session token; it
does not trust or kill a saved PID. An occupied port with an unverified owner is
reported as unavailable. It is never silently reassigned to another run.

**Stop backend** pauses scheduling, saves state and closes the host. Chess retains
its board history. Doom retains its detached game VM and checkpoints for reopening;
this button does **not** destroy all Microsandboxes. Detached VM RAM does not survive
host shutdown. The manager neither deletes recordings nor adopts historical demo
directories. Existing standalone runs remain available through the commands below.

`SESSIONS_PORT` (default `4316`) and `SESSIONS_DATA_DIR` (default `.data/sessions`)
configure the manager. Keep these stable when reopening it. Its versioned
`sessions.json` is private and contains control tokens. Do not publish it. Backend
startup failures are written to `runs/<id>/host.log`; no log is sent to the browser.
Chess hosts now hold a local process lease alongside their exclusive `.owner`
marker. After a crash, a new host can reclaim its version-2 marker only after
acquiring the lease and verifying the same host/directory and an absent owner
process. Old-format, malformed, moved or foreign-host markers and live/reused PIDs
are refused. Resolve those ownership errors explicitly before starting again;
the manager never removes a lock or kills a process to force a restart.

Lifecycle tests and browser checks use offline HTTP fixtures, including a detached
child and manager reconnection. Managed real-game creation/reopening and a
cross-game replay/learning isolation soak still need live qualification.

## Run separate sessions

From the repository root, use separate terminals and unique ports/directories:

```sh
PORT=4317 MOM_DATA_DIR=.data-doom npm run demo:doom
CHESS_PORT=4321 CHESS_DATA_DIR=.data/chess-main npm run demo:chess
CHESS_PORT=4322 CHESS_DATA_DIR=.data/chess-second npm run demo:chess
```

Each command starts paused. Doom needs a supported VM host and Jev credentials.
Plain chess needs Jev credentials; `CHESS_MODEL=fixture` selects a labelled offline
workflow fixture. Chess learning additionally needs the VM runtime and Codex CLI.
See the [Doom](../examples/doom/README.md) and [chess](../examples/chess/README.md)
guides before starting learning or adopting an existing session.

Never point two backends at the same data directory. Both games have process
leases; chess retains an exclusive `.owner` file for older hosts. Neither provides
multi-host shared storage coordination. The local servers are not authenticated
multi-user services.

## Configure standalone navigation

For independently launched backends, the gamepad menu links configured runs; it
does not start them. On loopback hosts, defaults link Doom on 4317 and chess on 4321. Other hosts show
only the current run unless a catalog is supplied. A custom-port current run is
included automatically.

`GAME_SESSIONS_JSON` is public build-time navigation metadata. Each entry needs
`id`, `game`, `gameLabel`, `title`, `description` and an absolute HTTP(S) `url`.
IDs and URLs must be unique. Never include credentials or private session state.

```sh
GAME_SESSIONS_JSON='[{"id":"doom","game":"doom","gameLabel":"Doom","title":"Main run","description":"Doom experiments","url":"http://localhost:4317/"},{"id":"chess","game":"chess","gameLabel":"Chess","title":"Chess run","description":"Alternate moves","url":"http://localhost:4321/"}]' npm run build:web
```

If using `demo:doom` or `demo:chess`, pass the same environment value to that
command because it rebuilds the viewer. Changing this catalog does not rename,
move, create or delete backend data. Unsupported URL schemes and URLs containing
credentials are rejected by the build configuration parser.
