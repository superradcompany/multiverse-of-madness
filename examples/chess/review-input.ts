import { canonicalJson, type EvaluationContract } from '@multiverse/gameplay-harness';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessStrategyFeedback } from './evaluation-feedback.ts';
import { chessIncidentContract } from './incident-contract.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { chessHarnessIncidentContract } from './evaluation-contract.ts';
import { defaultChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';

export interface FrozenChessReview {
  format: 1 | 2 | 3 | 4;
  id: string;
  mark: ChessAutomaticMark;
  contract: EvaluationContract<ChessStrategyScenario>;
  recentEvaluations?: ChessStrategyFeedback[];
  policy?: ChessPolicy;
}
/** Version four evaluates complete sessions; previous review bytes are never rewritten. */
export function freezeChessReview(id: string, mark: ChessAutomaticMark, recentEvaluations: ChessStrategyFeedback[], policy: ChessPolicy = defaultChessPolicy): FrozenChessReview {
  const captured = structuredClone(mark);
  return { format: 4, id, mark: captured, policy: structuredClone(policy), contract: chessHarnessIncidentContract(captured, policy), recentEvaluations: structuredClone(recentEvaluations) };
}
export function decodeFrozenChessReview(value: unknown, id: string): FrozenChessReview {
  const review = value as FrozenChessReview | undefined;
  try {
    if (!review || ![1, 2, 3, 4].includes(review.format) || review.id !== id
      || canonicalJson(review.contract) !== canonicalJson(review.format === 4 ? chessHarnessIncidentContract(review.mark, review.policy!) : chessIncidentContract(review.mark, review.format))) throw new Error('Review identity or cases differ');
    return structuredClone(review);
  } catch (error) { throw new Error('Missing or altered frozen chess incident contract', { cause: error }); }
}
