# Games and saved sessions

Each example backend owns one session directory. The gamepad button in either
viewer opens **Games & sessions** and navigates between configured backends.
Switching pages leaves game state, settings, learning history and replays with
their backend. A playing run continues; pause it first if you want it stopped.

The menu does not launch a server, create a session or migrate data. There is no
shared session-creation manager yet.

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

Never point two backends at the same data directory. Doom has a process lease;
chess has an exclusive `.owner` file. Neither provides multi-host shared storage
coordination. The local servers are not authenticated multi-user services.

## Configure the menu

On loopback hosts, defaults link Doom on 4317 and chess on 4321. Other hosts show
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
