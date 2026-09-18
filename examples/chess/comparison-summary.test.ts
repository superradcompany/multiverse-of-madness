import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POSITION } from 'chess.js';
import type { EvaluationComparison } from '@multiverse/gameplay-harness';
import { chessSampleGroups, summarizeChessComparison } from './comparison-summary.ts';
import { auditRegression } from './regression-audits.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';

function comparison(gains: number[]): EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence> {
  const baseline = { id: 'strategy', version: 'before' }, candidate = { id: 'strategy', version: 'after' };
  const contract = { id: 'samples', evaluator: { id: 'host', version: '3' }, maxRunMs: 1000,
    scenarios: gains.map((_, index) => ({ id: `case${index}`, seed: `seed${index}`, input: { saved: { initialFen: DEFAULT_POSITION, moves: [] }, objective: 'win', player: 'w' as const, plies: 8,
      sample: { id: 'private-position', index, count: gains.length } } })),
    budget: { simulationUnit: 'chess-plies', limits: { simulation: 8, modelCalls: 8 } },
    acceptance: { metric: 'value', direction: 'maximize' as const, minimumMeanGain: .1, maximumCaseRegression: 0 } };
  return { contract, baseline, candidate, accepted: false, reason: 'fixture', gains: [], runs: contract.scenarios.flatMap((scenario, index) => (['baseline', 'candidate'] as const).map(role => ({
    id: `${scenario.id}/${role}`, role, revision: role === 'baseline' ? baseline : candidate, scenarioId: scenario.id, seed: scenario.seed, status: 'complete',
    metrics: { value: role === 'baseline' ? 0 : gains[index]! }, budget: { version: 1, spec: contract.budget, entries: [] },
  }))) };
}

test('descriptive summaries show variability and partial evidence without inventing completed samples', () => {
  const report = comparison([1, -9, 2]);
  assert.deepEqual(summarizeChessComparison(report), { plannedPairs: 3, completedPairs: 3, positions: [{ planned: 3, completed: 3, mean: -2, min: -9, max: 2, improved: 2, tied: 0, worse: 1, baseline: { mean: 0, min: 0, max: 0 }, candidate: { mean: -2, min: -9, max: 2 } }] });
  assert.equal(auditRegression(report).regressed, false); // One bad draw must not force an automatic rollback.
  report.runs.at(-1)!.status = 'timeout';
  const partial = summarizeChessComparison(report); assert.equal(partial.completedPairs, 2); assert.equal(partial.positions[0]!.completed, 2);
  assert.equal(auditRegression(report).regressed, false);
  assert.equal(auditRegression(comparison([-2, -1, 0])).regressed, true);
  assert.equal(auditRegression(comparison([-1, -1, 9])).regressed, false); // Majority alone does not outweigh a positive mean.
});

test('sample requirements reject duplicate identities, missing repetitions and different histories or seeds', () => {
  const report = comparison([1, 0, -1]);
  const duplicate = structuredClone(report); duplicate.runs.push(duplicate.runs[0]!);
  assert.throws(() => summarizeChessComparison(duplicate), /Duplicate/);
  const missing = structuredClone(report.contract); missing.scenarios.pop(); assert.throws(() => chessSampleGroups(missing), /incomplete/);
  const index = structuredClone(report.contract); index.scenarios[1]!.input.sample!.index = 0; assert.throws(() => chessSampleGroups(index), /differ/);
  const history = structuredClone(report.contract); history.scenarios[1]!.input.saved.moves = ['e4']; assert.throws(() => chessSampleGroups(history), /differ/);
  report.runs[0]!.seed = 'wrong'; assert.throws(() => summarizeChessComparison(report), /identity/);
});
