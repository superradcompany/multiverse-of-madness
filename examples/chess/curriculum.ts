import { Chess } from 'chess.js';
import { canonicalJson, selectedTrainingScenarios, trainingMenu, type EvaluationContract, type TrainingCatalog, type TrainingSelection } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { chessHarnessContract } from './evaluation-contract.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessSave } from './runtime.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

/** Only recorded public positions, excluding every host acceptance board and repeated board. */
export function chessTrainingCatalog(mark: ChessAutomaticMark, acceptance: EvaluationContract<ChessStrategyScenario>): TrainingCatalog<ChessStrategyScenario> {
  const seen = new Set(acceptance.scenarios.map(scenario => board(scenario.input.saved)));
  const scenarios: TrainingCatalog<ChessStrategyScenario>['scenarios'] = [];
  const states = mark.evidence.observations.flatMap(observation => [observation.before, observation.after]).reverse();
  for (const state of states) {
    if (state.status !== 'ongoing') continue;
    const key = board(state);
    if (seen.has(key)) continue;
    const saved = { initialFen: state.initialFen, moves: [...state.moves] };
    const input: ChessStrategyScenario = { saved, objective: mark.evidence.mark.objective, player: 'w', plies: 4 };
    const id = contentRevision('observed-chess-practice', input).version;
    seen.add(key); scenarios.push({ id, seed: id, label: `Observed position at half-move ${state.ply}`,
      description: `${state.turn === 'w' ? 'White' : 'Black'} to move. Observed during ${mark.evidence.mark.issue}.`, input });
    if (scenarios.length === 4) break;
  }
  const fields = { format: 1 as const, maximumSelection: Math.min(2, scenarios.length), scenarios };
  return { ...fields, revision: contentRevision('chess-training-catalog', fields) };
}

/** Practice execution uses its own host allowances. Nothing from this contract can qualify a revision. */
export function chessTrainingContract(catalog: TrainingCatalog<ChessStrategyScenario>, selection: TrainingSelection, policy: ChessPolicy): EvaluationContract<ChessStrategyScenario> {
  const { revision, ...fields } = catalog;
  if (canonicalJson(revision) !== canonicalJson(contentRevision('chess-training-catalog', fields))) throw new Error('Altered chess training catalog');
  trainingMenu(catalog);
  return chessHarnessContract({ id: `practice-${contentRevision('selection', selection).version}`, evaluator: { id: 'chess-training', version: '1' },
    scenarios: selectedTrainingScenarios(catalog, selection),
    budget: { simulationUnit: 'chess-plies', limits: { simulation: 4, modelCalls: 4, executorCalls: 4 } }, maxRunMs: 300000,
    acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: 0, maximumCaseRegression: 0 },
  }, policy);
}

function board(saved: ChessSave): string {
  const game = new Chess(saved.initialFen); for (const move of saved.moves) game.move(move, { strict: true });
  return game.fen().split(' ').slice(0, 4).join(' ');
}
