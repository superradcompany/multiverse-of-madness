import { Chess } from 'chess.js';
import type { GameAdapter, PlanDefinition, DecisionModel, DecisionRequest, RankedChoice, EvidencePolicy } from '@multiverse/gameplay-harness';
import type { ChessState } from './runtime.ts';

export type ChessPlan = { san: string };
export type ChessExecution = { san: string; issued: boolean };
export type ChessMemory = { positions: string[] };
export type ChessStatistics = { plies: number; captures: number };
export interface ChessExperience { worldId: string; action: string; fen: string; afterFen: string; result: number; plies?: number }

/** Rules, plan mechanics and measured progress; all branching/lifecycle stays in the shared harness. */
export class ChessAdapter implements GameAdapter<ChessState, { san: string }, ChessPlan, ChessExecution, ChessMemory, ChessStatistics> {
  readonly version: { id: string; version: string };
  constructor(readonly player: 'w' | 'b' = 'w') { this.version = { id: 'chess.js-adapter', version: player === 'w' ? '1.4.0/1' : '1.4.0/1/black' }; }
  clock(state: ChessState) { return { sequence: state.ply, elapsed: state.ply, unit: 'turns' as const }; }
  episode(state: ChessState) { return state.initialFen; }
  terminal(state: ChessState) { return state.status === 'ongoing' ? 'ongoing' as const : state.status === 'checkmate' && state.turn !== this.player ? 'success' as const : 'failure' as const; }
  initialMemory(state: ChessState): ChessMemory { return { positions: [state.fen] }; }
  initialStatistics(state: ChessState): ChessStatistics { return { plies: state.ply, captures: state.moves.filter(move => move.includes('x')).length }; }
  observe(_before: ChessState, after: ChessState, memory: ChessMemory, stats: ChessStatistics) { memory.positions = [...memory.positions, after.fen].slice(-64); stats.plies = after.ply; stats.captures = after.moves.filter(move => move.includes('x')).length; }
  async candidates(state: ChessState): Promise<Array<PlanDefinition<ChessPlan>>> {
    return state.legalMoves.map(san => ({ id: san, version: '1', label: san, payload: { san }, requires: [],
      evidence: { sequence: state.ply, description: 'Legal move reported by chess.js' }, expectedBenefit: 'Improve the board position', maxDuration: { amount: 1, unit: 'turns' }, sideEffects: ['advances the game by one ply'] }));
  }
  start(plan: PlanDefinition<ChessPlan>): ChessExecution { return { san: plan.payload.san, issued: false }; }
  async next(execution: ChessExecution) {
    if (execution.issued) return { status: { status: 'complete' as const } };
    execution.issued = true; return { status: { status: 'running' as const }, command: { san: execution.san } };
  }
  measure(before: ChessState, after: ChessState, stats: ChessStatistics) { return { metrics: { value: this.value(after), plies: stats.plies, captures: stats.captures }, terminal: this.terminal(after), progress: before.fen !== after.fen }; }
  value(state: ChessState): number {
    if (state.status === 'checkmate') return state.turn === this.player ? -10000 : 10000;
    if (state.status === 'draw') return 0;
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    return new Chess(state.fen).board().flat().reduce((total, piece) => total + (piece ? values[piece.type] * (piece.color === this.player ? 1 : -1) : 0), 0);
  }
  evidence(): EvidencePolicy<ChessState, ChessExperience> {
    return { capture: (worldId, action, before, after) => ({ worldId, action, fen: before.fen, afterFen: after.fen, plies: after.ply - before.ply, result: this.value(after) - this.value(before) }),
      distance: (state, record) => state.fen === record.fen ? 0 : undefined, group: record => record.action, adverse: record => record.result < 0 };
  }
}

/** Reproducible provider for workflow qualification. Replace through DecisionModel for actual learning experiments. */
export class ChessFixtureModel implements DecisionModel<ChessState, ChessPlan, ChessExperience> {
  readonly version = { id: 'chess-workflow-fixture', version: '1' };
  async decide(request: DecisionRequest<ChessState, ChessPlan, ChessExperience>, signal: AbortSignal): Promise<RankedChoice> {
    signal.throwIfAborted();
    const plans = [...request.candidates].sort((a, b) => rank(b.payload.san) - rank(a.payload.san) || a.id.localeCompare(b.id));
    if (!plans.length) throw new Error('No legal chess plans');
    const weights = plans.map((_, i) => i === 0 ? 4 : 1), total = weights.reduce((a, b) => a + b, 0);
    return { selected: plans[0]!.id, preferences: plans.map((plan, i) => ({ id: plan.id, probability: weights[i]! / total })), confidence: .4,
      usage: { calls: 0 } };
  }
}
function rank(san: string): number { return Number(san.includes('#')) * 100 + Number(san.includes('+')) * 5 + Number(san.includes('x')) * 2; }
