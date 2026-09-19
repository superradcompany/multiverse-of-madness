# Chess

This example uses chess.js 1.4.0 for legal moves, checkmate/draw detection and
history-dependent rules. Jev chooses moves; the shared harness explores alternate
continuations, selects a board and preserves its complete history.

Board worlds run locally. They are exact copies of the starting position and
move history, not microVM forks. Optional learned preparation code runs in separate
Microsandbox executor VMs.

## Run

From the repository root, after `npm ci` and setting `TYPESAFE_API_KEY` in `.env`:

```sh
npm run demo:chess
```

Open <http://localhost:4321>. Requires Node.js 24+. The backend starts paused and
reopens its saved game after restart. Play continues across browser refreshes while
the backend is running.

For a deterministic workflow fixture without model calls, use a separate directory:

```sh
CHESS_MODEL=fixture CHESS_DATA_DIR=.data/chess-fixture npm run demo:chess
```

The fixture is labelled in the viewer. It does not interpret instructions or prove
playing strength. `CHESS_PORT` changes the port; `CHESS_DATA_DIR` changes the saved
session directory (default `.data/chess-live`). One backend owns each directory.

## Play and replay

- **Play / Pause** controls the backend loop. A single step can play a move,
  explore alternatives or promote a completed comparison.
- **Continue** commits the winning continuation. It preserves all moves played
  in that future, including opponent replies.
- The main board and alternate boards show whose turn it is. Moves played counts
  the selected route; moves explored includes discarded work.
- Pause before editing the goal or restoring a checkpoint.
- **Replay** views the selected history without moving the live board. Its endpoint
  stays fixed while the game continues.
- After checkmate or a draw, **New game** starts paused from the standard position.
  **Previous games** retains completed replays. The goal, remembered outcomes and
  active learned strategy carry forward; current-game counters/checkpoints reset.

The default policy forks two alternatives for two half-moves when confidence is
below 75%, captures checkpoints every four selected half-moves and retains three
checkpoints. An opponent reply is a separate decision, not a fixed scripted reply.
There is no chess clock. Confidence is preference concentration, not win probability.
Material/checkmate scoring is basic and does not establish strong chess play.

## Background learning

First install the VM runtime with `npm run setup:runtime` and authenticate Codex
CLI. Start a new learning-enabled session:

```sh
CHESS_LEARNING=1 CHESS_DATA_DIR=.data/chess-learning npm run demo:chess
```

The supervisor runs separately from live move selection. It reviews initial or
persistent problems, proposes TypeScript preparation code, tests it against the
current strategy, and applies qualified changes at a safe boundary. Jev keeps
choosing from legal moves. The background-learning card shows progress and can
pause owned learning work. Chess currently uses Codex; the Doom viewer also offers
Claude. Supervisor CLI permission prompts are bypassed.

Generated preparation can provide advisory guidance, select/annotate legal
candidates, select relevant supplied experience, and propose bounded temporary
goals. The host validates those outputs against the game state. It does not let
the supervisor redefine legal moves, the user's goal, or acceptance criteria.
Automatic chess qualification currently permits preparation-source changes only;
search policy, adapter and decision-model changes are not included.

New comparisons use the full fork/trial/promote loop, matched allowances, a fixed
baseline opponent, three samples at an incident position and three at a distinct
regression position. Missing or incomplete required runs cannot qualify a change.
Regression audits can restore an earlier strategy without rolling back the live
board. Small paired samples describe those runs, not general chess strength.

Open **Watch comparison / Replay comparison** to inspect recorded boards, switch
cases or seek through the moves. Viewing does not rerun Jev or create executor VMs.
Final scores remain labelled while viewing earlier positions. This is recorded
board history, not continuous video.

## Enable learning on an existing game

Stop its host after resolving any pending comparison with Continue, then opt in:

```sh
CHESS_LEARNING=1 CHESS_ADOPT_LEARNING=1 CHESS_DATA_DIR=.data/chess-live npm run demo:chess
```

Adoption preserves the board, moves, guide, policy, experience, checkpoints and
completed-game replays. Only subsequent decisions use learning; past moves retain
their original provenance. Later starts need neither flag. The original Jev
configuration must match, and an unresolved comparison prevents adoption.

Adoption writes session format 4, which older builds refuse. Keep a copy of the
stopped data directory if you need to return to an older build. Existing learning
sessions keep their original baseline. Offline tests cover continuation, rollback,
replay and interrupted publication; live Jev/VM migration is not yet qualified.

## Headless workflow

The CLI supports plain sessions. It does not attach the browser's learning host,
so use the browser entry to reopen a learning-enabled session.

```sh
npm run example:chess -- run --directory .data/chess-demo --cycles 4
npm run example:chess -- status --directory .data/chess-demo
npm run example:chess -- replay --directory .data/chess-demo --frame 2
npm run example:chess -- rollback --directory .data/chess-demo
```

The CLI defaults to the deterministic fixture. For real Jev, add `--model jev`
when creating a new directory. `--guide 'develop my pieces' --cycles 0` updates
instructions without playing. `--fen`, `--threshold`, `--breadth` and
`--trial-plies` configure a new session; an existing profile stays pinned.
`--checkpoint` selects an explicit rollback point. Cycles count workflow steps,
not a guaranteed number of moves.

Jev usage is recorded without a default call cap. The optional CLI
`--max-model-calls` sets an explicit limit for a new session; old saved limits
remain enforced. `--jev-model` pins the requested provider model. Reopening cannot
silently replace model or budget configuration.

## Storage and limitations

`session.json` holds the world tree, attempts, checkpoint references and experience.
`runtime/` stores complete board histories, `recordings/` holds selected replay,
`jev/` stores model configuration/receipts, and `learning/` holds strategy sources,
revision/jobs/audit journals and evaluation evidence when enabled.

The web host and CLI share an exclusive `.owner` file. An interrupted process can
leave a stale lock; verify the former process is gone before removing that file.
Never open one directory with two owners. See [sessions](../../docs/SESSIONS.md)
for independent runs and gamepad-menu configuration.

Session formats 1–3 remain readable: new-game history uses format 2, temporary goals
use format 3, and explicit learning adoption uses format 4. Recordings do not
replace runtime/checkpoint state. There is no external engine search, tablebase,
manual board-play UI or chess-strength rating.

See [architecture](../../docs/ARCHITECTURE.md), [verification](../../VERIFICATION.md)
and the [historical qualification reports](../../docs/history/chess-example-2026-09-19.md).
The ordinary-play, proposal and rollback reports show integration; stronger play
and shared session creation remain unfinished.
