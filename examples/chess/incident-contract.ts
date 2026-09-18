import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { EvaluationContract } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

const policy = { format: 1, plies: 8, maxRunMs: 180000, minimumIncidentGain: .1, minimumMeanGain: .1, maximumCaseRegression: 0 };
// Scoring and matched allowances are unchanged; every proposal freezes its full case set separately.
export const chessIncidentContractVersion = contentRevision('chess-incident-evaluation-policy', policy);
export type ChessIncidentCases = 1 | 2 | 3;
const repeatedEvaluator = contentRevision('chess-repeated-incident-evaluation', { policy: chessIncidentContractVersion, repetitions: 3, minimumImprovedIncidentPairs: 2 });

/** Capture before generation. Version 1 exists only to verify previously frozen review inputs. */
export function chessIncidentContract(mark: ChessAutomaticMark, cases: ChessIncidentCases = 3): EvaluationContract<ChessStrategyScenario> {
  if (cases === 3) {
    const original = chessIncidentContract(mark, 2);
    return { ...original, id: `chess-incident-${mark.evidence.mark.key}-cases3`, evaluator: repeatedEvaluator,
      scenarios: original.scenarios.flatMap(scenario => Array.from({ length: 3 }, (_, index) => {
        const { minimumGain, ...input } = scenario.input;
        return { id: `${scenario.id}-sample${index + 1}`, seed: `${scenario.seed}/sample${index + 1}`,
          input: { ...structuredClone(input), sample: { id: scenario.id, index, count: 3,
            ...(minimumGain === undefined ? {} : { minimumMeanGain: minimumGain, minimumImprovedPairs: 2 }) } } };
      })) };
  }
  const incident = structuredClone(mark.evidence.incident), objective = mark.evidence.mark.objective;
  if (incident.status !== 'ongoing') throw new Error('Chess incident must precede the terminal outcome');
  const regression = cases === 1 ? { id: 'ordinary-opening', seed: 'ordinary-opening', moves: [] } : distinctRegression(incident.fen);
  return { id: `chess-incident-${mark.evidence.mark.key}${cases === 1 ? '' : '-cases2'}`, evaluator: chessIncidentContractVersion,
    scenarios: [
      { id: 'incident', seed: contentRevision('saved-chess-position', incident).version,
        input: { saved: { initialFen: incident.initialFen, moves: incident.moves }, objective, player: 'w', plies: policy.plies, minimumGain: policy.minimumIncidentGain } },
      { id: regression.id, seed: regression.seed, input: { saved: { initialFen: DEFAULT_POSITION, moves: regression.moves }, objective, player: 'w', plies: policy.plies } },
    ], budget: { simulationUnit: 'chess-plies', limits: { simulation: policy.plies, modelCalls: policy.plies, executorCalls: policy.plies } }, maxRunMs: policy.maxRunMs,
    acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: policy.minimumMeanGain, maximumCaseRegression: policy.maximumCaseRegression } };
}
/** Private host cases, not plans exposed to the agent. Compare board state, not move counters. */
function distinctRegression(incidentFen: string) {
  const candidates = [{ id: 'ordinary-opening', moves: [] as string[] }, { id: 'queen-pawn-opening', moves: ['d4', 'd5', 'c4', 'e6'] }];
  const board = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
  for (const candidate of candidates) {
    const game = new Chess(DEFAULT_POSITION);
    for (const move of candidate.moves) game.move(move, { strict: true });
    if (board(game.fen()) !== board(incidentFen)) return { ...candidate, seed: `host-cases2/${candidate.id}` };
  }
  throw new Error('No distinct chess regression position');
}
