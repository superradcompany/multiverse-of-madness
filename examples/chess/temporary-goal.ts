import { randomUUID } from 'node:crypto';
import { Chess, type Square } from 'chess.js';
import { z } from 'zod';
import { advanceScopedGoal, createScopedGoal, decodeScopedGoal, canonicalJson, type GoalFrame, type ScopedGoal, type ScopedGoalRules, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { ChessState } from './runtime.ts';

const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('occupy'), square: z.string().regex(/^[a-h][1-8]$/), piece: z.enum(['p', 'n', 'b', 'r', 'q', 'k']) }),
  z.strictObject({ kind: z.literal('material'), minimum: z.number().int().min(-39).max(39) }),
  z.strictObject({ kind: z.literal('check') }), z.strictObject({ kind: z.literal('checkmate') }),
]);
export type ChessGoalTarget = z.infer<typeof targetSchema>;
export interface ChessTemporaryGoal { key: string; record: ScopedGoal<ChessGoalTarget> }
export interface ChessGoalContext { frame: GoalFrame; player: 'w' | 'b'; current?: ChessTemporaryGoal }
export const chessGoalProposalSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/), instruction: z.string().trim().min(1).max(240), reason: z.string().trim().min(1).max(240),
  evidence: z.array(z.literal('current-state')).length(1), duration: z.number().int().min(1).max(32), target: targetSchema,
});
export type ChessGoalProposal = z.infer<typeof chessGoalProposalSchema>;
const rules: ScopedGoalRules<ChessGoalTarget> = { version: { id: 'chess-temporary-goal', version: '1' }, maxDuration: 32,
  parseTarget: value => targetSchema.parse(value), hasEvidence: () => false };

export function chessGoalFrame(input: { scopeId: string; gameId?: string; state: ChessState; player: 'w' | 'b'; objective: string; source: VersionRef }): GoalFrame {
  return { scope: { id: input.scopeId, version: contentRevision('chess-goal-game', { initialFen: input.state.initialFen, player: input.player, gameId: input.gameId ?? null }).version },
    context: contentRevision('chess-goal-context', { objective: input.objective }), source: input.source, clock: { unit: 'chess-plies', value: input.state.ply } };
}
export function decodeChessTemporaryGoal(value: unknown): ChessTemporaryGoal {
  canonicalJson(value);
  const parsed = z.strictObject({ key: chessGoalProposalSchema.shape.key, record: z.unknown() }).parse(value);
  const record = decodeScopedGoal(parsed.record, rules);
  if (!Number.isInteger(record.draft.duration) || record.draft.instruction.length > 240 || record.draft.reason.length > 240
    || record.draft.evidence.length !== 1 || !/^chess-state:sha256:[0-9a-f]{64}$/.test(record.draft.evidence[0]!)) throw new Error('Invalid chess goal record');
  return { key: parsed.key, record };
}
export function advanceChessTemporaryGoal(goal: ChessTemporaryGoal, frame: GoalFrame, state: ChessState, player: 'w' | 'b'): ChessTemporaryGoal {
  const checked = decodeChessTemporaryGoal(goal);
  return { key: checked.key, record: advanceScopedGoal(checked.record, frame, state, rules, (target, current) => {
    const game = new Chess(current.fen);
    if (current.status === 'draw' || (current.status === 'checkmate' && current.turn === player)) return { status: 'failed', reason: 'The game ended without a win for the controlled player' };
    let complete: boolean;
    switch (target.kind) {
      case 'occupy': { const piece = game.get(target.square as Square); complete = piece?.color === player && piece.type === target.piece; break; }
      case 'material': {
        const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
        const balance = game.board().flat().reduce((sum, piece) => sum + (piece ? values[piece.type] * (piece.color === player ? 1 : -1) : 0), 0);
        complete = balance >= target.minimum; break;
      }
      case 'check': complete = current.turn !== player && game.isCheck(); break;
      case 'checkmate': complete = current.status === 'checkmate' && current.turn !== player; break;
    }
    return { status: complete ? 'completed' : current.status === 'ongoing' ? 'active' : 'failed',
      reason: complete ? 'Goal condition observed on the board' : current.status === 'ongoing' ? 'Goal condition not yet observed' : 'Game ended before the goal condition occurred' };
  }) };
}
/** The planner may guide the controlled side; it cannot enlist the opponent to complete its goal. */
export function proposeChessTemporaryGoal(proposal: ChessGoalProposal | undefined, context: ChessGoalContext | undefined, state: ChessState): ChessTemporaryGoal | undefined {
  if (!context) { if (proposal) throw new Error('Temporary goals require a host-owned chess scope'); return; }
  const current = context.current && advanceChessTemporaryGoal(context.current, context.frame, state, context.player);
  if (!proposal || state.turn !== context.player) return current;
  const { key, ...draft } = chessGoalProposalSchema.parse(proposal);
  if (current?.key === key) return current;
  const reference = `chess-state:${contentRevision('chess-state', state).version}`;
  const goal = { key, record: createScopedGoal(randomUUID(), { ...draft, evidence: [reference] }, context.frame, { ...rules, hasEvidence: candidate => candidate === reference }) };
  return advanceChessTemporaryGoal(goal, context.frame, state, context.player);
}
