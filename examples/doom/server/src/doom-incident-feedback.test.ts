import test from 'node:test';
import assert from 'node:assert/strict';
import { doomIncidentFeedback } from './doom-incident-feedback.ts';

test('failed incident learning includes useful observations without exposing private acceptance cases', () => {
  const run = (scenarioId: string, label: string) => ({ scenarioId, role: 'candidate', status: 'complete', metrics: { score: 10100, cells: 0, gameSeconds: 36, privateMetric: 99 }, evidence: {
    initial: { x: 1, y: 2, z: 3, episode: 1, map: 2 }, final: { x: 2, y: 3, z: 3, episode: 1, map: 2 },
    session: { mainId: 'main', worlds: [{ id: 'main', plan: { label, step: 2, status: 'complete' } }] },
    decisions: Array.from({ length: 3 }, () => ({ decision: { action: 'advance', plans: { selected: 'switch', candidates: [{ id: 'switch', label }] } } })),
    planFailures: [{ worldId: 'private-id', feedback: { label, reason: 'route blocked', step: 1, target: { x: 3, y: 4, z: 5 } } }],
  } });
  const result = doomIncidentFeedback({ runs: [run('private-opening', 'secret test route'), run('saved-stuck-position', 'approach switch')] });
  assert.equal(result!.runs.length, 1);
  const actual = result!.runs[0]!;
  assert.equal(actual.metrics!.cells, 0); assert.equal(actual.lastSelectedPlan!.status, 'complete');
  assert.deepEqual(actual.choicesAcrossTrialFutures, [{ label: 'approach switch', decisions: 3 }]);
  assert.equal(actual.recentStops![0]!.reason, 'route blocked');
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('secret test route'));
});
test('missing, malformed and legacy evidence never invents incident outcomes', () => {
  for (const value of [undefined, {}, { runs: [{ scenarioId: 'opening', role: 'baseline', status: 'complete' }] }]) assert.equal(doomIncidentFeedback(value), undefined);
  const result = doomIncidentFeedback({ runs: [{ scenarioId: 'saved-stuck-position', role: 'candidate', status: 'error' }] });
  assert.equal(result!.runs[0]!.status, 'error'); assert.equal(result!.runs[0]!.metrics, undefined);
});

test('incomplete incident feedback distinguishes rejected batches from unexecuted gameplay', () => {
  const evidence = {
    initial: { x: 1, y: 2, z: 3, episode: 1, map: 2 }, final: { x: 1, y: 2, z: 3, episode: 1, map: 2 },
    initialStats: { seconds: 60, attempts: { seconds: 10, deaths: 1, rejectedBatches: 2, retries: 2, rollbacks: 1 } },
    session: { mainId: 'private-runtime', worlds: [{ id: 'private-runtime' }],
      stats: { seconds: 60, attempts: { seconds: 253, deaths: 4, rejectedBatches: 3, retries: 3, rollbacks: 1 } },
      recovery: { failures: 1, message: 'Rejected batch: lost at least 30 health. Retry 1/1.', checkpoints: [{ id: 'private-checkpoint' }] } },
    decisions: [{ decision: { action: 'retreat and fire' } }],
  };
  const result = doomIncidentFeedback({ runs: [
    { scenarioId: 'private-opening', role: 'candidate', status: 'error', evidence },
    { scenarioId: 'saved-stuck-position', role: 'candidate', status: 'error', evidence },
  ] })!;
  assert.equal(result.runs.length, 1);
  const run = result.runs[0]!;
  assert.equal(run.status, 'error'); assert.equal(run.metrics, undefined);
  assert.equal(run.selectedGameSeconds, 0);
  assert.deepEqual(run.trialWork, { seconds: 243, deaths: 3, rejectedBatches: 1, retries: 1, rollbacks: 0 });
  assert.deepEqual(run.recovery, { failures: 1, message: evidence.session.recovery.message });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});
