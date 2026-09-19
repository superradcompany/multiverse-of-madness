import { advanceChessTemporaryGoal, decodeChessTemporaryGoal } from './temporary-goal.ts';
import { canonicalJson, requirePlanCapabilities, type GameCapabilities } from '@multiverse/gameplay-harness';
import type { ChessDecisionRequest } from './preparation.ts';
import type { ChessDecisionModel } from './revisions.ts';

/** Shared live/evaluation boundary: preparation may select and annotate, never rewrite engine facts. */
export async function decideChess(model: ChessDecisionModel, input: ChessDecisionRequest, signal: AbortSignal, capabilities: GameCapabilities) {
  signal.throwIfAborted();
  const request = structuredClone(input);
  for (const plan of request.candidates) requirePlanCapabilities(plan, capabilities);
  const prepared = model.prepare ? await model.prepare(structuredClone(request), signal) : request;
  if (!same(prepared.state, request.state) || prepared.objective !== request.objective || !same(prepared.revision, request.revision)
    || !prepared.candidates.length || new Set(prepared.candidates.map(plan => plan.id)).size !== prepared.candidates.length
    || prepared.candidates.some(plan => !request.candidates.some(original => same({ ...plan, label: original.label, expectedBenefit: original.expectedBenefit }, original)))
    || prepared.experience.some(record => !request.experience.some(original => same(original, record)))) throw new Error('Chess preparation changed host-owned decision facts');
  if (!same(prepared.temporaryGoal?.frame ?? null, request.temporaryGoal?.frame ?? null)
    || prepared.temporaryGoal?.player !== request.temporaryGoal?.player) throw new Error('Chess preparation changed host-owned goal scope');
  if (prepared.temporaryGoal?.current) {
    const goal = decodeChessTemporaryGoal(prepared.temporaryGoal.current), context = prepared.temporaryGoal;
    const observed = advanceChessTemporaryGoal(goal, context.frame, request.state, context.player);
    if (goal.record.status === 'active' && observed.record.status !== 'active') throw new Error('Chess preparation returned a stale or unassessed temporary goal');
  }
  const context = prepared.temporaryGoal;
  if (context && request.state.turn !== context.player) {
    const previous = request.temporaryGoal?.current;
    const expected = previous ? advanceChessTemporaryGoal(previous, context.frame, request.state, context.player) : undefined;
    if (!same(context.current ?? null, expected ?? null)) throw new Error('Opponent preparation cannot replace the controlled player goal');
  }
  signal.throwIfAborted();
  // Keep our validated menu private from providers which mutate their arguments.
  for (const plan of prepared.candidates) requirePlanCapabilities(plan, capabilities);
  const plans = structuredClone(prepared.candidates), answer = structuredClone(await model.decide(structuredClone(prepared), signal));
  signal.throwIfAborted();
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !plans.some(plan => plan.id === answer.selected)
    || answer.preferences.length !== plans.length || new Set(answer.preferences.map(p => p.id)).size !== plans.length
    || answer.preferences.some(p => !plans.some(plan => plan.id === p.id) || !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1)
    || Math.abs(answer.preferences.reduce((sum, p) => sum + p.probability, 0) - 1) > .000001) throw new Error('Invalid chess decision distribution');
  return { plans, answer, ...(prepared.temporaryGoal?.current ? { temporaryGoal: structuredClone(prepared.temporaryGoal.current) } : {}) };
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
