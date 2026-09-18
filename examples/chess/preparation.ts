import { z } from 'zod';
import type { DecisionRequest, VersionRef } from '@multiverse/gameplay-harness';
import type { ChessExperience, ChessPlan } from './adapter.ts';
import type { ChessState } from './runtime.ts';

/** Advisory strategy is separate from the user objective and engine facts. */
export interface ChessStrategyContext { revision: VersionRef; guidance: string }
export interface ChessDecisionRequest extends DecisionRequest<ChessState, ChessPlan, ChessExperience> { strategy?: ChessStrategyContext }
export const chessPreparationSchema = z.strictObject({
  abi: z.literal('chess-preparation/1'),
  guidance: z.string().trim().max(2000),
  plans: z.array(z.strictObject({ id: z.string().min(1).max(32), label: z.string().trim().min(1).max(120), expectedBenefit: z.string().trim().min(1).max(400) })).min(1).max(255),
  experienceIndices: z.array(z.number().int().nonnegative()).max(64),
});

/** Only annotate/select host-supplied legal plans and measured evidence. Never replace facts or controls. */
export function prepareChessRequest(output: unknown, request: ChessDecisionRequest): ChessDecisionRequest {
  const result = chessPreparationSchema.parse(output), available = new Map(request.candidates.map(plan => [plan.id, plan]));
  if (available.size !== request.candidates.length || !available.size) throw new Error('Invalid host chess candidate pool');
  if (new Set(result.plans.map(plan => plan.id)).size !== result.plans.length || result.plans.some(plan => !available.has(plan.id))) throw new Error('Prepared chess plans must refer to distinct available candidates');
  if (new Set(result.experienceIndices).size !== result.experienceIndices.length || result.experienceIndices.some(index => index >= request.experience.length)) throw new Error('Prepared chess evidence is not in the observed pool');
  return { ...structuredClone(request),
    candidates: result.plans.map(plan => ({ ...structuredClone(available.get(plan.id)!), label: plan.label, expectedBenefit: plan.expectedBenefit })),
    experience: result.experienceIndices.map(index => structuredClone(request.experience[index]!)),
    strategy: { revision: { ...request.revision }, guidance: result.guidance },
  };
}
