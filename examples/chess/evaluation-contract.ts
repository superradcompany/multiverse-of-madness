import { canonicalJson, type EvaluationContract, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { chessIncidentContract } from './incident-contract.ts';
import { parseChessPolicy } from './policy.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

const evaluatorId = 'chess-full-harness-incident-evaluation';
/** Frozen semantics: complete actual trials, score the selected prefix, count all attempted work. */
export function chessHarnessEvaluator(policy: ChessPolicy) {
  return contentRevision(evaluatorId, { format: 1, policy: parseChessPolicy(policy), scoring: 'selected-prefix', resources: 'all-attempts' });
}
export function chessHarnessContract(contract: EvaluationContract<ChessStrategyScenario>, policy: ChessPolicy): EvaluationContract<ChessStrategyScenario> {
  const evaluator = chessHarnessEvaluator(policy);
  const allowance = Math.max(...contract.scenarios.map(scenario => scenario.input.plies + policy.trialPlies - 1)) * policy.breadth;
  return { ...structuredClone(contract), id: `${contract.id}-full-harness-v1`, evaluator,
    budget: { simulationUnit: 'chess-plies', limits: { simulation: allowance, modelCalls: allowance, executorCalls: allowance } }, maxRunMs: 300000 };
}
export function chessHarnessIncidentContract(mark: ChessAutomaticMark, policy: ChessPolicy) {
  return chessHarnessContract(chessIncidentContract(mark, 3), policy);
}
export function isChessHarnessEvaluator(evaluator: VersionRef, policy: ChessPolicy): boolean {
  if (evaluator.id !== evaluatorId) return false;
  if (canonicalJson(evaluator) !== canonicalJson(chessHarnessEvaluator(policy))) throw new Error('Unsupported chess harness evaluator or search policy');
  return true;
}
