import { Chess } from 'chess.js';
import { canonicalJson, type LearningObservation, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { ChessAdapter } from './adapter.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';
import type { ChessState } from './runtime.ts';
import type { ChessStrategyEvidence } from './strategy-proposal.ts';

export type ChessLearningIssue = 'bootstrap' | 'goal-changed' | 'repetition' | 'material-loss' | 'lost-game' | 'draw' | 'goal-failed';
export interface ChessLearningMark {
  key: string; objective: string; revision: VersionRef; issue: ChessLearningIssue;
  attemptedPlies: number; selectedPlies: number; observedAt: number;
}
export interface ChessLearningEvidence extends LearningObservation<ChessLearningMark> {
  /** Host-authored exact history immediately before the incident window, never just a FEN. */
  incident: ChessState;
  observations: ChessStrategyEvidence['observations'];
  temporaryGoal?: ChessStrategyEvidence['temporaryGoal'];
}
export const chessReviewIntervalMs = 120000;

/** Pure local observation; callers durably claim this mark before dispatching generation.
 * Only selected gameplay diagnoses the problem. Failed alternate futures remain available separately.
 */
export function observeChessLearning(snapshot: ChessSessionCheckpoint, previous?: ChessLearningMark,
  options: { now?: number; player?: 'w' | 'b'; bootstrap?: boolean; goalSettled?: boolean; revision?: VersionRef } = {}): ChessLearningEvidence | undefined {
  if (snapshot.batch || snapshot.pendingFork || Object.keys(snapshot.pendingInputs).length) return;
  const world = snapshot.worlds.find(item => item.meta.id === snapshot.mainId);
  if (!world) throw new Error('Chess observation is missing the selected world');
  const { state } = world, now = options.now ?? Date.now(), player = options.player ?? 'w';
  if (previous && now - previous.observedAt < chessReviewIntervalMs) return;
  const goalChanged = previous !== undefined && previous.objective !== snapshot.objective && options.goalSettled === true;
  // Refreshes and wall-clock time alone are not fresh gameplay evidence.
  if (previous && snapshot.attempts.plies <= previous.attemptedPlies && !goalChanged) return;
  const game = new Chess(state.initialFen), windowStart = Math.max(0, state.moves.length - 8);
  const observations: ChessStrategyEvidence['observations'] = [];
  const positions = new Map<string, number>();
  const capture = (): ChessState => ({ initialFen: state.initialFen, moves: game.history(), fen: game.fen(), turn: game.turn(), ply: game.history().length,
    legalMoves: game.moves().sort(), status: game.isCheckmate() ? 'checkmate' : game.isDraw() ? 'draw' : 'ongoing' });
  const remember = () => { const key = positionKey(game.fen()); positions.set(key, (positions.get(key) ?? 0) + 1); };
  remember(); let incident = capture();
  for (const [index, selected] of state.moves.entries()) {
    const before = index >= windowStart ? capture() : undefined;
    game.move(selected, { strict: true }); remember();
    if (before) { if (index === windowStart) incident = before; observations.push({ before, selected, after: capture() }); }
  }
  if (canonicalJson(capture()) !== canonicalJson(state)) throw new Error('Chess observation does not match its saved move history');
  const adapter = new ChessAdapter(player);
  const issue: ChessLearningIssue | undefined = goalChanged ? 'goal-changed'
    : state.status === 'checkmate' && state.turn === player ? 'lost-game'
    : state.status === 'draw' ? 'draw'
    : (positions.get(positionKey(state.fen)) ?? 0) >= 2 ? 'repetition'
    : observations.length >= 4 && adapter.value(state) - adapter.value(incident) <= -2 ? 'material-loss'
    : world.temporaryGoal && ['expired', 'failed'].includes(world.temporaryGoal.record.status) ? 'goal-failed'
    : options.bootstrap && !previous && state.ply >= 4 ? 'bootstrap' : undefined;
  if (!issue || (state.status === 'checkmate' && state.turn !== player && !goalChanged)) return;
  const revision = options.revision ?? snapshot.provenance.learning?.revision ?? snapshot.provenance.model;
  const key = contentRevision('chess-learning-incident', { objective: snapshot.objective, revision, issue,
    initialFen: state.initialFen, position: positionKey(state.fen), value: adapter.value(state) }).version;
  // A failed review may be revisited only after substantial new attempts and a longer cooldown.
  if (previous?.key === key && (snapshot.attempts.plies - previous.attemptedPlies < 8 || now - previous.observedAt < 300000)) return;
  return { mark: { key, objective: snapshot.objective, revision: { ...revision }, issue, attemptedPlies: snapshot.attempts.plies, selectedPlies: state.ply, observedAt: now },
    incident, observations, ...(world.temporaryGoal ? { temporaryGoal: structuredClone(world.temporaryGoal) } : {}), reason: reasons[issue] };
}
const reasons: Record<ChessLearningIssue, string> = {
  'goal-failed': 'The temporary goal expired or failed. Use its recorded outcome and board history to revise the plan without changing the user objective or blindly renewing the deadline.',
  bootstrap: 'Create a reusable strategy from the game contract and initial observed play.',
  'goal-changed': 'Adapt strategy to the new user goal while preserving that goal exactly.',
  repetition: 'The selected run has revisited the same position; find alternatives that make progress instead of repeating the loop.',
  'material-loss': 'The selected run lost at least two material points in the recent window; analyze the decisions and improve the available alternatives.',
  'lost-game': 'The controlled player was checkmated; analyze the preceding decisions and test a recovery strategy from the saved incident.',
  draw: 'The selected run ended in a draw; first assess whether this satisfies the user goal. If it does not, analyze preceding decisions and test alternatives from the saved incident.',
};
function positionKey(fen: string): string { return fen.split(' ').slice(0, 4).join(' '); }
