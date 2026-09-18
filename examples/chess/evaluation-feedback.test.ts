import test from 'node:test';
import assert from 'node:assert/strict';
import type { RevisionJournal, EvaluationComparison } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { chessEvaluationFeedback } from './evaluation-feedback.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';

const before = { id: 'source', version: 'before' }, after = { id: 'source', version: 'after' };
const report: EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence> = {
  contract: { id: 'private-case', evaluator: { id: 'host', version: '1' }, maxRunMs: 1000,
    scenarios: [{ id: 'private-position', seed: 'secret-seed', input: { saved: { initialFen: 'private-fen', moves: ['private-move'] }, objective: 'win', player: 'w', plies: 1 } }],
    budget: { simulationUnit: 'chess-plies', limits: { simulation: 1, modelCalls: 1 } },
    acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: .1, maximumCaseRegression: 0 } },
  baseline: before, candidate: after, accepted: false, reason: 'Required incident was worse', gains: [{ scenarioId: 'private-position', gain: -2 }],
  runs: [{ id: 'private-run', role: 'candidate', revision: after, scenarioId: 'private-position', seed: 'secret-seed', status: 'error', error: 'private-fen leaked by executable',
    budget: { version: 1, spec: { simulationUnit: 'chess-plies', limits: {} }, entries: [] } }],
};
function journal(): RevisionJournal<ChessPolicy> {
  const qualification = { baseline: before, candidate: after, contract: { id: 'test', version: '1' }, context: { id: 'goal', version: '1' }, accepted: false,
    reason: report.reason, evidence: { comparison: contentRevision('chess-strategy-comparison', report) } };
  return { version: 1, rules: { contract: qualification.contract, capabilities: ['executor'], maxLifetimeMs: 1000 }, initial: before, active: { epoch: 0, revision: before }, artifacts: [], history: [],
    proposals: [0, 1, 2].map(index => ({ id: String(index), basedOn: { epoch: 0, revision: before }, candidate: after, context: qualification.context, capabilities: ['executor'],
      reason: 'Test source', createdAt: index, expiresAt: 1000, status: 'rejected', qualification })) };
}

test('supervisor feedback is compact, verified, and excludes private tests, moves, seeds and raw errors', async () => {
  const read: string[] = [];
  const feedback = await chessEvaluationFeedback(journal(), async id => { read.push(id); return structuredClone(report); });
  assert.deepEqual(read, ['2', '1']); assert.equal(feedback.length, 2);
  assert.deepEqual(feedback[0]!.pairedGains, [-2]); assert.equal(feedback[0]!.objective, 'win'); assert.equal(feedback[0]!.metric, 'value');
  assert.doesNotMatch(JSON.stringify(feedback), /private-|secret-seed/);
  await assert.rejects(chessEvaluationFeedback(journal(), async () => ({ ...report, accepted: true })), /qualified report/);
  const bad = journal(); bad.proposals[2]!.qualification!.candidate = before;
  await assert.rejects(chessEvaluationFeedback(bad, async () => report), /qualified report/);
});

test('repeated evaluation feedback reports compact variation without private positions or per-run duplication', async () => {
  const repeated = structuredClone(report);
  repeated.contract.scenarios = [0, 1, 2].map(index => ({ ...structuredClone(report.contract.scenarios[0]!), id: `private-position-${index}`, seed: `secret-seed-${index}`,
    input: { ...structuredClone(report.contract.scenarios[0]!.input), sample: { id: 'private-group', index, count: 3 } } }));
  repeated.runs = repeated.contract.scenarios.flatMap((scenario, index) => (['baseline', 'candidate'] as const).map(role => ({
    id: `private-${index}-${role}`, scenarioId: scenario.id, seed: scenario.seed, role, revision: role === 'baseline' ? before : after, status: 'complete',
    metrics: { value: role === 'baseline' ? 0 : [1, -9, 2][index]! }, budget: { version: 1, spec: repeated.contract.budget, entries: [] },
  })));
  const saved = journal(); for (const proposal of saved.proposals) proposal.qualification!.evidence = { comparison: contentRevision('chess-strategy-comparison', repeated) };
  const feedback = await chessEvaluationFeedback(saved, async () => repeated);
  assert.equal(feedback[0]!.samples!.completedPairs, 3); assert.equal(feedback[0]!.samples!.positions[0]!.mean, -2);
  assert.deepEqual(feedback[0]!.runs, []); assert.doesNotMatch(JSON.stringify(feedback), /private-|secret-seed|initialFen/);
});
