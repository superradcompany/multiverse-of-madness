# Existing-game example: chess

This example reuses [chess.js](https://github.com/jhlywa/chess.js) 1.4.0. It provides
legal moves, checkmate/draw detection and repetition rules. The adapter supplies
chess observations, one-move plans and measured outcomes. The public harness owns
learning-cycle order, trials, promotion, checkpoint recovery, experience and replay
ancestry through the same components used by Doom.

## Browser demo

After `npm ci` and adding your Jev key to the root `.env`, run from the repository root:

```sh
npm run demo:chess
```

Open <http://localhost:4321>. New sessions use real Jev and require
`TYPESAFE_API_KEY` in the server environment or root `.env`. The host starts
paused. Play runs in the backend across browser refreshes; Next decision runs
one harness cycle. Compare alternative boards, continue with the winner, edit
the goal while paused, restore checkpoints, or inspect selected-path replay.
Replay pins its endpoint so subsequent promotions do not change the path being
inspected. Restarting the host reopens the saved session paused.

`CHESS_PORT` and `CHESS_DATA_DIR` select the port and persistent session directory
(defaults: `4321`, `.data/chess-live`). `CHESS_MODEL=fixture` creates a deterministic
workflow demo without model calls; its label explicitly identifies the test player.
The host and CLI share the `.owner` lock and cannot write the same session together.
Use a separate directory for a different model configuration. For background learning, first run `npm run setup:runtime`, then start a separate
session with `CHESS_LEARNING=1 CHESS_DATA_DIR=.data/chess-learning npm run demo:chess`.
This additionally requires an authenticated Codex CLI. Saved learning sessions
reopen with their original supervisor binding automatically. To enable learning
on an existing plain-Jev game, stop its host and opt in explicitly:

```sh
CHESS_LEARNING=1 CHESS_ADOPT_LEARNING=1 CHESS_DATA_DIR=.data/chess-live npm run demo:chess
```

Finish any pending comparison with Continue before stopping the plain host.
Adoption preserves the board, moves, goal, policy, remembered outcomes, checkpoints
and completed-game replays. Only subsequent decisions use the learning system;
historical moves keep their original provenance. Later starts need neither flag.
The existing Jev model configuration must match. This writes session format 4,
which older builds refuse to open. Keep a copy of the stopped session directory
if you need to return to an older build. Existing learning sessions and plain
sessions without explicit adoption retain their format.

Offline tests cover adoption, reconnect, old-checkpoint rollback, completed-game
replay and interrupted publication. This migration has not yet been qualified
with live Jev and VM preparation.

The shared gamepad menu switches between configured Doom and chess sessions.
The chess runtime remains a separately owned web entry and data directory.
Board histories use local chess.js worlds. Learning-enabled sessions run preparation
code in real isolated executor VMs, with separate ownership for live play and
background evaluation. The background-learning card shows review/testing status,
active revision and the latest outcome; its toggle cancels and joins owned work.

Browser qualification on 2026-09-18 used real Jev from the ordinary starting board:
4 comparisons, 16 attempted plies and 8 selected-path plies. Refresh during play,
pause, promotion and recorded-board replay worked. A host restart preserved the
exact worlds, checkpoints and attempt counts; mobile replay had no horizontal
overflow. This is integration evidence,
not evidence of strong play or completed autonomous learning. Controller tests also
cover joined cancellation, conflicting commands and reconnect/rollback preservation.

## Run a persistent session

From the application root, with Node 24+ and dependencies installed:

```sh
npm run example:chess -- run --directory .data/chess-demo --cycles 4
npm run example:chess -- status --directory .data/chess-demo
npm run example:chess -- run --directory .data/chess-demo --cycles 2
npm run example:chess -- replay --directory .data/chess-demo --frame 2
npm run example:chess -- rollback --directory .data/chess-demo
```

The default decision provider is a deterministic workflow fixture. It prefers
checks/captures and otherwise chooses alphabetically; it does not learn or interpret
user guidance. Its purpose is reproducible lifecycle testing, not playing strength.

Each cycle either plays one main-world move, explores futures, or promotes a
completed comparison. By default, an uncertain white decision forks two futures
for two plies each (one white and one black move). The original world remains
unchanged during exploration. The next cycle promotes the entire winning state,
including its move history. Main-path statistics and total attempted plies are
reported separately. The material/checkmate evaluator chooses from the measured
outcomes; it does not accept a model's claimed score.

New-session options are `--fen`, `--threshold` (0–1), `--breadth` (1–8) and
`--trial-plies` (1–32). `--cycles` is a workflow-cycle limit, not a move count.
Existing session configuration stays pinned. Use a new directory to compare a
different profile. `--guide '...'` updates guidance during `run`; `--cycles 0`
updates it without playing. Models receive the current guide at each judgment.

Execution checkpoints are automatic, initially and every four main-path plies,
with the newest three retained. `rollback` defaults to the latest checkpoint;
`--checkpoint <id>` selects one shown by `status`. Rollback restores exact game
history without erasing attempt counts or observed experience. Full-trial losses
from discarded futures remain available when deciding again from the same board.

`replay` reports the stitched selected path. `--frame <zero-based-index>` prints
its recorded ASCII board and provenance. Selected ancestry is retained; discarded
recordings have age/count/size collection. Recording retention can exceed its soft
limits when needed to preserve selected history.

The game runtime is **local and file-backed**, not a Microsandbox VM. It persists
initial FEN plus complete move history and verifies reconstructed state on reconnect.
Closing the CLI preserves worlds, checkpoints and replays. There is one writer per
directory, enforced by `.owner`. An abrupt host death leaves that lock for inspection;
verify its process has stopped before removing the stale lock. Runtime input journals
recover an acknowledged move without applying it twice. Never run two hosts against
the same directory. The CLI and standalone browser viewer use the same session; neither is yet a
game selector in the Doom web UI.

## Use real Jev decisions

Set `TYPESAFE_API_KEY` server-side (the command loads an optional root `.env`), then:

```sh
npm run example:chess -- run --directory .data/chess-jev --model jev --max-model-calls 64 --cycles 4
npm run example:chess -- run --directory .data/chess-jev --cycles 4
```

The provider receives the board, legal moves, current guide/statistics and retrieved
measured attempts. On black's turn it asks for competitive opposition, rather than
cooperation with white. Every actual API call is recorded in the shared usage
ledger before dispatch, across all futures and restarts. New sessions have no
lifetime call cap by default; `--max-model-calls` opts into one explicitly. Failed or interrupted calls
consume their reservation; automatic retries are disabled. Token usage is recorded
when reported, but is not a hard token/spend cap. Exhausting an explicitly configured call limit stops the
run. Reading status, replaying and rollback do not require model calls.

`--jev-model <model-id>` selects the requested model for a new session; the default
is `jev-latest`. The requested provider configuration and prompts have a content
identity. An alias does not pin remote weights: the actual serving model, request,
raw response, confidence, token usage and selected move are saved under `jev/decisions/`.
No credentials are saved there. The current integration accepts rounding errors
of up to 0.02 in the probability total, normalizes accepted preferences and retains
the exact response. Unknown choices, missing entries, invalid numbers and larger
distribution errors remain rejected. This fix advances the provider identity to
integration 2; older integration-1 sessions refuse an unversioned reconnect. Keep
their directories intact and use a new session for this version. Model and lifetime call limits cannot silently change
on reconnect. The provider implements the public `DecisionModel` port; neither Jev
nor chess is imported by the generic harness.

A short live run verifies integration only. It does not establish chess strength,
confidence calibration, held-out improvement or a matched-compute benchmark. The
file runtime reconstructs histories for validation; that engine work is not a
simulation-throughput measurement.

## Executable-revision qualification

```sh
npm run qualify:executor
```

This separate qualification uses a real Microsandbox VM for each source revision
invocation. Three fixed mate-in-one positions compare a deterministic first-legal
baseline against two controlled code proposals. Invalid action/self-reported score
output is rejected by the host. A legal mate selector is independently measured,
qualified and activated in a continuing `ChessSession`. Three separate processes
create and qualify the revisions, restart and play the improved source to checkmate,
then restart and continue with the original executable after rollback. World
checkpoint rollback preserves global attempt counts and revision history. Artifacts,
comparisons, source/build hashes, budget journals and all 15 VM receipts live under
`artifacts/executable-qualification/`. Each invocation VM is destroyed and its cleanup
acknowledgment is recorded.

Both revisions receive identical simulation/executor-call caps and per-invocation
VM limits. Wall time is observed, not an exact CPU budget. These source changes are
fixtures, not autonomous supervisor discoveries, and the easy positions are not a
chess-strength or held-out learning benchmark. Autonomous proposal generation and
activation in the live Doom application remain in progress.

## Bind a continuing session to a supervisor

`ChessLearningBinding` connects a `RevisionController<ChessPolicy>` to the session.
Its stable identity refers to the separately durable supervisor journal. There is
no second active pointer in `session.json`: the session reads and pins the current
artifact at each cycle. Each world, comparison, checkpoint and replay frame retains
its producing activation epoch, policy, model, adapter and executor references.
On reconnect these references must resolve to revisions that actually were active.
Existing unsupervised sessions continue to load without a binding; supervised ones
require the same journal identity.

The controller's `boundary` port must call `session.revisionBoundary(work)` and its
`context` port must call `session.supervisorContext()`. An in-flight decision or
unresolved comparison refuses activation. Guide edits are fenced while publication
is pending. A failed write acknowledgment stops use of that controller until both
controller and session reopen from authoritative storage.

The binding's model factory receives the complete immutable learning artifact.
`ChessExecutableModel` passes its policy, prompts, skills, user guide and observations
to the isolated provider, validates its selection against the host's legal candidates,
and reserves each invocation in the shared budget ledger. The source cannot claim
its own outcome or rewrite the independent evaluator. The session applies revised
trial/routing, memory and checkpoint policy only at the next safe cycle.

World rollback and learning-revision rollback are deliberately separate operations.
Restoring an old board preserves its historical provenance; its next move uses the
currently active compatible learning revision. `controller.rollback` selects an
explicit previously active executable and advances the activation epoch. The
qualification command demonstrates both operations and durable recovery.


## Generated strategy preparation followed by Jev

`ChessPreparedModel` composes the public `executeLearningStage` with a decision
model. The active strategy's source runs in an isolated executor and returns
`chess-preparation/1`: selected legal candidate IDs, short plan annotations,
advisory guidance and indices into measured experience. The host retains the
original move payloads, board, user objective and revision. It rejects invented
moves, duplicate options, fabricated experience or altered host-owned facts before
asking Jev. Jev receives strategy advice separately from the user's goal, alongside
current board/statistics and measured attempts, and chooses each move.

`ChessSession` applies optional preparation before judgment, so its actual trial
menu, labels, promotion and replay reflect the validated prepared candidates.
Unprepared models retain the original behavior and saved session format.

`proposeChessStrategy` supplies the game description to a replaceable supervisor
provider and stores returned source without running it on the host. Generation
alone does not qualify or activate a revision. The caller owns the persistent job,
request deduplication, independent comparisons and safe activation boundary.

```sh
node --env-file=.env --import tsx scripts/chess-strategy-smoke.ts
```

This integration run asks the installed Codex CLI for a strategy from the mechanics
contract, starting from a generic pass-through source and no training observations.
It uses the generated source unchanged in real networkless VMs, lets real Jev play
a separate session, and checks reconnect, replay and VM cleanup. Codex uses the
requested permission bypass; generation and model accounting have no lifetime
spending/call cap. Executor invocations retain isolation/resource/deadline bounds.
Outputs are saved under `artifacts/chess-strategy/`.

This command is bootstrap integration, not an independent game-quality comparison.
It does not activate the proposal in the browser session or implement automatic
background improvement. Empty training evidence must not be called learning from
failures. The report records which checks actually finished.

Verified bootstrap run: `artifacts/chess-strategy/2026-09-18T14-47-54.005Z`.
Codex generated the strategy in 163.548 seconds, reporting 26,494 input tokens,
5,229 output tokens and 6,400 cached input tokens (no dollar cost reported). The
stored executable exactly matches its returned source. Six networkless executor
VMs prepared menus and guidance for real Jev; the selected path was
`Nf3 Nf6 Nc3 Nc6`, with 8 attempted plies across two comparisons. Every executor
receipt settled as released, and provider lookups found none remaining.

The initial run's reconnect assertion compared an absent optional field with
`undefined`. The assertion was corrected to compare every JSON-persisted field;
`--verify artifacts/chess-strategy/2026-09-18T14-47-54.005Z` then reopened the same
run and verified state, replay and cleanup without generating or editing source.
The original failed check and successful verification are distinct evidence.
This run generated annotated candidates and advisory guidance; it retained all
legal choices. It did not prove that pruning alternatives improves results.

## Game description for the supervisor

`description.ts` supplies the public harness `GameDescription`: FEN/history/legal
move semantics, one-ply controls, turn timing, plan payloads, host-measured outcomes,
file-backed fork/restore capabilities and limitations. It describes mechanics,
not an opening repertoire. `generateChessRevision` includes this description in
its recorded evidence and refuses an adapter mismatch before dispatch.

Tests compare those fields and controls with the actual chess runtime and exercise
the proposal boundary with a recording provider. The prepared-strategy qualification described above also supplies this description
to real Codex generation. Automatic background improvement in the browser remains
unfinished.

## Generate a source proposal from observed failures

`npm run qualify:supervisor` uses the installed Claude Code login through the
application's optional, tool-free `ClaudeCodeSupervisor` provider with medium
reasoning effort. It records two
baseline losses on training positions, supplies those traces and the current
source, and requests one complete TypeScript move-selector. The three acceptance
positions stay outside that request. No generated source runs in the host process.

Generation has one invocation reservation, a five-minute deadline, bounded JSON
input/output and a $2 provider cutoff. The host records actual reported usage,
including failed calls; the cutoff can overshoot on a completed request. A timeout
or invalid response ends the experiment without activation. Pending reservations
must not be automatically retried after a host crash.

A valid returned source is stored unchanged and evaluated with the same independent
one-input budget as the baseline. Only an accepted proposal continues through
activation, process restart and rollback qualification. `generation.json` contains
the provider receipt and raw response; `generated-artifact.json` links the reason,
captured origin and verified source identity. This is an integration qualification
on handselected positions, not a benchmark of general chess improvement. Inspect
the saved report before claiming that a particular generation succeeded.


Verified run: `artifacts/executable-qualification/2026-09-18T05-08-11.230Z`.
The Claude-generated source achieved checkmate in 3/3 withheld mate-in-one cases,
versus 0/3 for the first-candidate baseline, with no post-generation edits. After
activation and process restart it played `Qe8#`, retaining the two-frame replay;
another restart after rollback used the original source at epoch 2. All 17 real
executor VMs were released and a provider query found none remaining. Generation
took 72.611 seconds and reported 6,786 input tokens, 6,124 output tokens and
$0.201893. Receipts identify the actual main and auxiliary models. Earlier default-
effort attempts timed out; their failure receipts remain separate. This result
establishes the generation/evaluation/recovery path, not general chess strength.

## Independent preparation-strategy comparison

`compareChessStrategies` runs paired, single-path games from complete saved move
histories. Both sides receive the same initial position and ply/decision allowances.
Only the controlled player's strategy changes; the opponent always uses the frozen
baseline artifact. `decideChess` applies the same host-fact, legal-plan and probability
validation in the live session and evaluator. The host measures material, checkmate,
draws and actual plies from chess.js, independently of generated output. A scenario
can require its own `minimumGain`, so improvement elsewhere cannot hide failure at
that incident. This evaluator does not qualify changes to future-search policy.

Run a saved bootstrap against an ordinary opening and a frozen position eight plies
before a saved browser endpoint:

```bash
curl -fsS http://localhost:4321/api/chess -o /tmp/chess-view.json
node --env-file=.env --import tsx scripts/chess-strategy-evaluation.ts \
  artifacts/chess-strategy/2026-09-18T14-47-54.005Z /tmp/chess-view.json
```

The command copies the unchanged proposal into a new artifact directory and does
not change the browser session or activate the result. `manifest.json` freezes the
source revisions, evaluator source digest, image, positions, objective, allowances
and acceptance rule before execution. Raw Jev responses, preparation receipts,
per-run accounting, exact moves and the full comparison remain available.

Verified run: `artifacts/chess-strategy-evaluation/2026-09-18T15-01-18.696Z`.
All four eight-ply runs completed. The candidate gained one more material point than
the baseline in each pair: opening values were +2 versus +1, and the position before
live repetition was +1 versus 0. This met the pinned mean-gain rule. All 32 real
executor VMs were released and verified absent; 32 Jev calls reported 63,431 input
and 6,045 output tokens. No new supervisor generation was requested. Neither pair
ended in checkmate or draw. These short, unseeded model samples do not establish
full-game strength, reliable loop recovery or automatic browser learning.

`openChessStrategyLearning` connects this evaluator to the durable generic
`RevisionController` and returns a `ChessLearningBinding`. The application must own
exclusive directory access, model/executor cleanup, observation scheduling, and the
session's `revisionBoundary`/`supervisorContext`. Only preparation-source changes
are accepted by this connection. It verifies artifact digests, stores comparisons,
uses the session boundary for activation, preserves replay provenance, and restores
the authoritative active revision after restart. A changed goal invalidates pending
results; a new evaluation requires a matching host-authored contract. Tests exercise
actual measured fixture comparisons through activation, reconnect, rollback, stale
goal rejection and mismatched-goal refusal. Those tests do not run real VMs.

`learning-host.ts` now connects the browser observer/scheduler, Codex provider,
prepared Jev decisions and revision controller for learning-enabled sessions.
The existing browser session on 4321 remains on its original plain-Jev binding;
qualification uses a separate data directory.

## Background observation and job ownership

`observeChessLearning` diagnoses selected gameplay locally, with no model call.
It detects repeated positions, recent material losses, failed endings, settled goal
changes, and optional initial strategy bootstrap. It freezes the preceding eight
plies and exact incident history for generation/evaluation. Routine play, unchanged
polls, unresolved comparisons and pending inputs do not trigger reviews. Reviews
are spaced by at least two minutes; an unchanged issue needs eight new attempted
plies and five minutes before reconsideration. A draw is evidence to assess against
the user's goal, not necessarily an unwanted outcome.

`ChessLearningJobs` claims each request durably before dispatch, keeps one job busy
through joined cleanup, and never dispatches the same ID twice. Restart first
reconciles owned executor resources and marks unfinished requests interrupted.
An ambiguous CLI outcome therefore cannot silently cause another paid request.
Storage or cleanup failure fences further admission until authoritative reopen.

`ChessAutomaticLearning` connects these owners to the generic autonomous state
machine and revision controller. Its backend wake loop works without viewers;
generation/evaluation run as separate tasks. Evidence and proposal origin are frozen
in the autonomous journal, and activation waits for the application's natural
boundary. Disabling learning joins only its own jobs; shutdown preserves the saved
enabled preference. After activation, the review window starts from fresh gameplay.

Controlled tests verify frozen evidence, nonblocking admission, lost generation
acknowledgment after successful submission, boundary-only activation, restart
without duplicate work, cancellation/cleanup joining and failed-write fencing.
`web-server.ts` now attaches these components through `openChessLearningHost`.
Before each generation, the host saves the exact incident, user goal, origin and
independent comparison contract. The incident requires its own improvement; a
different opening position provides the regression case. Evaluation never receives candidate-
selected metrics or tests. The proposal request receives observed gameplay and the
issue diagnosis, but not the private comparison cases. Scheduled gameplay yields
while revision publication owns the session boundary, then continues without a
spurious concurrent-operation error.

The ordinary chess CLI does not yet open learning-enabled sessions. Existing plain
sessions are preserved and cannot be silently relabelled as learned history.
Navigation between configured game/session viewers is available. A shared session-creation
workflow and explicit historical-session transition remain open, along with broader
gameplay-strength and sustained-operation qualification.

## Automatic browser qualification (2026-09-18)

The learning-enabled host on port 4322 uses
`artifacts/chess-automatic/2026-09-18/session`. It automatically reviewed gameplay
at four selected plies, while the ordinary session on 4321 remained unchanged.
A comparison and promotion advanced the game to six plies during generation.

The first proposal completed in 434.083 seconds. Independent evaluation measured
an incident gain of -2 relative to the baseline and rejected it without activation.
The second review, triggered by the observed material loss, completed in 278.617
seconds. It gained +1 in each paired case, activated as revision 1 automatically,
and continued the same selected move history to eight plies. The early incident
window began at ply zero, so both comparison cases started on the initial board;
this is repeated opening evidence, not distinct held-out-position coverage or a
full-game strength result.

A controlled restart preserved the complete session JSON, active revision, enabled
preference and nine-frame selected replay. Four jobs remained complete; no proposal
was regenerated. All 60 executor VMs (12 live, 48 evaluation) were verified absent.
Evidence is under `artifacts/chess-automatic/2026-09-18/evidence`, including the
comparison receipts, continuation snapshots and `restart-report.json`. Gameboards
remain local chess.js worlds; only preparation code runs in those VMs.

The two generation receipts reported 319,946 input tokens, including 225,408 cached
input tokens, and 22,409 output tokens in total. Bootstrap cost remains a limitation.
Following that observation, proposals now receive compact summaries of the latest
two verified evaluations and favor small strategic changes over rebuilding chess
rules/search. Historical source remains unchanged. Feedback verifies the controller's
comparison digest and omits private positions, moves, seeds and raw executor errors.
The changes are loaded after the restart, but a token reduction has not yet been
measured. The panel now supports elapsed review time and explicit outcome reasons.

Format-2 review inputs introduced a regression board distinct from the
incident, ignoring move counters when comparing positions. Format 1 inputs remain
verifiable under their original cases, without rewriting historical evidence.
The standalone evaluator can reuse an active strategy without another generation:

```sh
node --env-file=.env --import tsx scripts/chess-strategy-evaluation.ts \
  --learning-session artifacts/chess-automatic/2026-09-18/session
```

The distinct-case run in
`artifacts/chess-strategy-evaluation/2026-09-18T17-06-03.666Z` rejected revision 1:
incident gain was +1, but the queen-pawn opening regressed by 9 material points.
All four eight-ply runs completed and all 32 executor VMs were verified removed.
This diagnostic neither activates nor rolls back a live revision. The original
activation remains in history; the new evidence shows that broader gameplay
quality is not established.

## Checks after activation

Background learning can now check an active source against its immediate
predecessor when new adverse gameplay is observed. It runs at most once per
activation epoch and evaluator version, outside the play loop, without generating
another strategy. An activation qualified under an older evaluator receives one
check using the current comparison rules. Failed or interrupted checks are not
automatically retried under the same evaluator.
All pairs finish before a rollback decision: missing, cancelled or failed runs
are inconclusive, and failure to improve is not treated as regression.

The host owns the cases and metrics. A measured regression restores the previous
strategy only at a safe boundary and only if the activation epoch and user goal
still match the frozen evidence. Board state, replay and the original activation
record remain intact. Reports and ownership are durable; interrupted comparisons
are not automatically dispatched again. Cleanup completes before another review
can start. Compact verified results feed the next supervisor request, without
revealing private test boards. The UI shows the latest strategy check.

The first live automatic check (`084913c4-d325-449f-87d8-61d655f33e2d`) completed
four eight-ply runs, measured gains of +1 and 0, and retained revision 1. This
differs from the earlier standalone +1/-9 comparison; model sampling is not
seed-controlled, so short paired runs do not establish chess strength. Broader,
repeated evaluations remain necessary. The saved game, replay and original chess
session were unchanged, and all 92 recorded executor VMs (including the 32 new
audit VMs) were verified absent. Evidence:
`artifacts/chess-automatic/2026-09-18/evidence/regression-audit.json`.
Regression rollback, stale goals, cancellation, interrupted comparisons and lost
publication acknowledgments have controlled tests. A real autonomous rollback is
not claimed by this retained-result run.
A controlled restart preserved the complete API view, session, audit/job journals
and executor records without dispatching another comparison; see
`artifacts/chess-automatic/2026-09-18/evidence/regression-audit-restart.json`.

## Repeated evaluation

Format-3 frozen review inputs use three paired eight-ply runs at the incident
and three at a distinct regression position, with separate journals and alternating
role order. All six pairs are required. At least two incident pairs must improve,
the incident mean must meet its threshold, and no paired run may regress under
the existing non-regression rule. Rollback audits require a negative mean and a
majority of worse pairs at a position; one unfavorable sample alone cannot roll
back a strategy. Historical format-1 and format-2 inputs keep their original rules.

Summaries include relative gain, range, better/tied/worse counts and both strategies'
absolute outcome changes. This exposes shared poor play that relative gains hide.
The supervisor receives this compact summary instead of duplicated per-run metrics;
private positions, move histories and seeds remain excluded. Three samples are a
descriptive check, not a statistical-confidence or general chess-strength claim.
Each complete new evaluation uses up to 96 preparation/decision calls, instead of
32, but adds no supervisor generation calls and does not run every gameplay turn.

The real repeated check at
`artifacts/chess-strategy-evaluation/2026-09-18T17-55-45.570Z` completed all 12 runs
and passed its fixed relative-improvement gate. Incident gains were +1/+1/+1;
regression-position gains were 0/+9/0. Both systems still played poorly there:
the baseline lost nine material points in all three runs, and the learned strategy
did so in two. The report establishes a sampled relative improvement, not strong
play. All 96 executor VMs were verified removed and both live sessions were
unchanged. `expanded-summary.json` adds the derived absolute-outcome summary to
the original immutable comparison and summary artifacts.
The run used 96 Jev decisions (194,141 reported input tokens, 20,803 output tokens;
median decision latency 182 ms) and zero supervisor generation calls. These are
diagnostic measurements, not user-managed spending limits. See `usage-summary.json`.

## Evaluate the full exploration loop

The single-path checks above do not test the session's fork-and-select behavior.
An isolated replay of the observed `Qd7+` queen loss used the actual session loop:
it explored that losing line, selected `Qd1 Bb4+` with no material loss, preserved
history on reconnect, and removed all three preparation VMs. The evidence is in
`artifacts/chess-branch-diagnostic/2026-09-18T18-05-54.575Z`. This one-position
diagnostic uses the active source for both sides, matching live self-play; it is
not an independent strategy comparison.

The standalone evaluator also supports paired **full-harness** comparisons:

```sh
node --env-file=.env --import tsx scripts/chess-strategy-evaluation.ts \
  --learning-session artifacts/chess-automatic/2026-09-18/session --harness

# Reuse frozen histories and source artifacts without needing an idle live session.
node --env-file=.env --import tsx scripts/chess-strategy-evaluation.ts \
  --comparison artifacts/chess-strategy-evaluation/2026-09-18T17-55-45.570Z --harness
```

These runs use `ChessSession` for decisions, branching, multi-ply trials, promotion,
experience, checkpoints and selected-path replay. Both roles face the same frozen
baseline opponent. Every dispatched move, including discarded futures, is charged
before execution. Preparation and model calls have matched per-run allowances.
The CLI allows up to `(selected horizon + trial length - 1) × breadth` for each
resource. It finishes the final trial even when it crosses the scoring endpoint,
then scores the same selected-path prefix in both roles. All additional work stays
metered; evidence includes the complete committed board and replay endpoint as
well as the scored prefix. It stops at clean boundaries and refuses qualification
when a nonterminal run does not reach the required horizon. Terminal games may
finish earlier. Each comparison has a separate evaluator identity and data
directory; historical single-path receipts are not rewritten.

The real run in `artifacts/chess-strategy-evaluation/2026-09-18T18-21-14.994Z`
completed all 12 eight-ply selected paths. Opening gains were +1/-2/-4; queen-pawn
gains were +17/+18/+11. Despite the positive overall mean, the opening regressions
failed the fixed acceptance rules. All 143 preparation VMs were verified absent.
No source was generated, activated or rolled back. Three samples per position
remain descriptive evidence, not a general strength claim.

Parallel evaluation exposed concurrent writes to one executor journal through
separate file-store instances. Each executor pool now owns a single serial writer,
including live play. The interrupted diagnostic retained its rejection and verified
all 59 VMs absent. After deploying the fix, both API views, the learning session and
its revision/audit/executor journals matched their pre-restart values exactly; see
`rollout.json` in the successful full-harness run.

## Full-loop background qualification

New automatic reviews and regression audits now freeze format 4, including the
search policy and full-harness evaluation identity. They use the same repeated
positions and improvement rules as format 3, but run the actual fork/trial/promote
loop and count discarded work. Formats 1–3 still decode and execute under their
original single-path rules. Unknown full-harness evaluator versions or mismatched
search policies refuse before dispatch. This still qualifies source changes only;
it does not authorize model, adapter or policy replacement.

To qualify a saved source through the durable revision controller without
generating, activating or changing a live session:

```sh
node --env-file=.env --import tsx scripts/chess-strategy-evaluation.ts \
  --comparison artifacts/chess-strategy-evaluation/2026-09-18T17-55-45.570Z --qualify
```

The real controller check at
`artifacts/chess-strategy-evaluation/2026-09-18T18-31-01.118Z` completed 12 paired
runs and durably rejected the saved source. Opening gains were -2/-3/-2 and
queen-pawn gains +11/+18/+18; gains elsewhere could not compensate for opening
regressions. All 144 preparation VMs were verified absent. Reopening the controller
preserved the rejection with epoch zero and did not open a live model or repeat
the comparison. Controlled tests also cover opponent-first incidents whose final
trial crosses the scored endpoint, and prevent shortened runs from causing rollback.

After loading this code on port 4322, both live API views, the saved game and the
revision/audit/automatic/job/executor journals matched their pre-restart values.
No job or executor was added. Existing qualified history is preserved; the new
contract applies to future reviews rather than silently rewriting old decisions.
See `rollout.json`, `controller-reconnect.json` and `usage-summary.json` in that run.

## Watch and replay background comparisons

The background-learning card opens **Watch comparison** while testing, or
**Replay comparison** afterward. The main pane shows the two strategies at the
time of that test. Select a position/sample, play the recorded moves, step forward
or backward, or drag the shared replay control. Final scores remain explicitly
labelled while replaying earlier positions. Tests run one role at a time; the
other board shows its completed path or waits its turn. Your main game can
continue separately.

New full-loop comparisons publish selected-path updates and labelled trial-board
previews. Completed paths are reconstructed and verified from the recorded engine
history, with the same scoring endpoint for both roles. They are not fresh game
runs. Refreshing or opening replay does not call Jev or allocate VMs. The viewer
polls only while open and following the test; manual replay holds its current
recording. The summary explains better/tied/worse samples and what the score means.

`learning/comparison-preview.json` is a serial presentation cache, never an input
to qualification, activation or supervisor feedback. A stopped test is marked
interrupted on reopen. A matching verified final receipt restores the completed
view after a lost preview acknowledgment. Preview delivery failures cannot alter
the independent result or prevent runtime cleanup. The latest comparison is
available in the viewer; historical authoritative receipts and harness recordings
remain in their evaluation directories.

On 2026-09-18 the deployed viewer opened the actual four-run regression audit,
with nine recorded positions per run. Play/pause, seeking, position switching,
and 320–1440px layouts passed browser checks without horizontal overflow. Live
trial presentation used a controlled browser fixture and real-session controller
tests; it is not claimed as another live paid evaluation. Both live games and
their learning journals stayed unchanged, and no model/executor was dispatched.
See `artifacts/chess-automatic/2026-09-18/evidence/comparison-view-rollout.json`.


## Automatic rollback under full-loop evaluation

The live audit `2252d3c9-02c4-4c32-ab74-d874bc462f1c` completed all 12 runs using
format 4. Incident gains were +5/+5/+5; opening gains were -4/-3/+1. The opening
regressed in two of three samples with a mean loss of 2 score points, so the host
automatically restored the original source at activation epoch 2. The complete
saved board and history stayed unchanged during rollback. The next continuation
reached 14 selected plies using epoch 2 and preserved the preceding 12 moves.
This demonstrates the rollback path, not reliable chess strength.

Audit journal format 2 allows one check per activation epoch and evaluator
identity. Opening a format-1 journal preserves its records and validates its
original unique-epoch invariant before updating the header. The older host cannot
read the new journal format. Historical evaluation receipts are not rewritten.
A changed evaluator permits a new check; reopening the same evaluator does not.
The live viewer showed actual comparison progress during this audit.
Evidence: `artifacts/chess-automatic/2026-09-18/evidence/versioned-audit/`.


The later safe restart, after the next review completed, preserved both game views
apart from the new `lastOutcome.active` flag and preserved all saved journal
values. The jobs decoder normalized object-key order only. No paid work was
redispatched, and all 775 recorded executor VMs were verified absent. A proposal
that was once applied is no longer labelled as currently in use after rollback.
See `versioned-audit/restart-complete.json` in the evidence directory above.


## Start another game

After checkmate or a draw, **New game** replaces the disabled Finished button.
It opens the standard starting position and leaves play paused. The current-game
move/comparison counters and checkpoint list reset. Your goal, policy, remembered
outcomes and active learned strategy carry forward. **Previous games** offers the
completed game's selected replay, independent of the new game's replay.

The backend requires the current finished-world ID, refuses mid-game or duplicate
requests, records allocation intent before creating a fresh root, and commits the
new game plus completed-game entry through durable promotion. The old runtime is
released only after publication. Interrupted allocation/publication resumes from
the saved intent; old selected recordings remain retained after archived metadata
is collected. A new game changes the supervisor context, so work frozen for the
old game cannot activate against it.

Session format 1 remains readable and unchanged until New game is requested.
That action writes format 2 with completed-game references and restart intent.
Older hosts refuse format 2 rather than silently dropping its history. This does
not change Microsandbox disks, snapshots or the harness's persisted formats.

The deployed learning session restarted from its 97-half-move draw, retained all
98 replay positions and strategy revision 2, and reconnected with identical saved
values and no additional model/executor work. Both viewers expose the action;
the plain session's finished board was left intact. Browser checks cover replay,
refresh and widths 320/390/768/1440. Evidence:
`artifacts/chess-new-game/2026-09-18/`.

### Temporary goals

A strategy planner can return `chess-preparation/2` with an optional temporary
goal, separate from your main objective. Targets include occupying a square with
a specified piece, reaching a material balance, giving check or delivering
checkmate. The host checks the board and ends the goal on completion, failure,
expiry or a changed game, guide or strategy. Deadlines use half-moves; reaching
the deadline expires the goal before checking completion. Repeated keys never
renew deadlines. Opponent decisions do not receive the controlled side's goal.

The sidebar shows the current goal and outcome. Goals follow futures, promotion,
selected replays, saved games and checkpoints. A new game starts a new pursuit;
old game evidence remains available in replay. Failed or expired goals can cause
an automatic review using the existing cooldown and duplicate suppression.

Goal-bearing sessions use format 3; this build reads older formats, while older
builds reject format 3 rather than discard goal state. The prior preparation ABI
remains supported. Lifecycle qualification with real VM preparation and Jev:

```bash
node --env-file=.env --import tsx scripts/qualification/chess-goals.ts
```

This fixture checks integration and cleanup. It does not establish stronger chess
play or autonomous generation of useful goals. Board worlds remain local exact
histories; only strategy execution uses VMs.
