import { canonicalJson, type EvaluationContract, type TrainingCatalog } from '@multiverse/gameplay-harness';
import { chessTrainingCatalog } from './curriculum.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessStrategyFeedback } from './evaluation-feedback.ts';
import type { ChessTrainingFeedback } from './training-feedback.ts';
import { chessIncidentContract } from './incident-contract.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { chessHarnessIncidentContract } from './evaluation-contract.ts';
import { defaultChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';

export interface FrozenChessReview {
  format: 1 | 2 | 3 | 4 | 5;
  id: string;
  mark: ChessAutomaticMark;
  contract: EvaluationContract<ChessStrategyScenario>;
  recentEvaluations?: ChessStrategyFeedback[];
  policy?: ChessPolicy;
  training?: TrainingCatalog<ChessStrategyScenario>;
  recentTraining?: ChessTrainingFeedback[];
}
/** Version five adds a separate public practice catalog; prior review bytes and acceptance rules stay intact. */
export function freezeChessReview(id: string, mark: ChessAutomaticMark, recentEvaluations: ChessStrategyFeedback[], policy: ChessPolicy = defaultChessPolicy, recentTraining: ChessTrainingFeedback[] = []): FrozenChessReview {
  const captured = structuredClone(mark);
  const contract = chessHarnessIncidentContract(captured, policy);
  return { format: 5, id, mark: captured, policy: structuredClone(policy), contract, training: chessTrainingCatalog(captured, contract), recentEvaluations: structuredClone(recentEvaluations), recentTraining: structuredClone(recentTraining) };
}
export function decodeFrozenChessReview(value: unknown, id: string): FrozenChessReview {
  const review = value as FrozenChessReview | undefined;
  try {
    if (!review || ![1, 2, 3, 4, 5].includes(review.format) || review.id !== id
      || canonicalJson(review.contract) !== canonicalJson(review.format >= 4 ? chessHarnessIncidentContract(review.mark, review.policy!) : chessIncidentContract(review.mark, review.format as 1 | 2 | 3))) throw new Error('Review identity or cases differ');
    if (review.format === 5 && canonicalJson(review.training) !== canonicalJson(chessTrainingCatalog(review.mark, review.contract))) throw new Error('Training catalog differs');
    if (review.format < 5 && (review.training !== undefined || review.recentTraining !== undefined)) throw new Error('Legacy reviews cannot contain a training catalog');
    return structuredClone(review);
  } catch (error) { throw new Error('Missing or altered frozen chess incident contract', { cause: error }); }
}
