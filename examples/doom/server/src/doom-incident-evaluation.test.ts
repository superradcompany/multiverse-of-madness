import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationComparison, EvaluationContract } from '@multiverse/gameplay-harness';
import { requireDoomIncidentImprovement, stuckScenarioId } from './doom-incident-evaluation.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';
import type { DoomEvaluationEvidence } from './doom-revision-evaluation.ts';

const original: EvaluationContract<DoomVmScenario> = { id: 'test', evaluator: { id: 'score', version: '1' },
  scenarios: [{ id: 'opening', seed: '1', input: { setup: [] } }], budget: { simulationUnit: 'ticks', limits: { simulation: 1, modelCalls: 1 } },
  maxRunMs: 1000, acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
function report(incident: number, opening: number): EvaluationComparison<DoomVmScenario, DoomEvaluationEvidence> {
  return { contract: original, baseline: { id: 'a', version: '1' }, candidate: { id: 'b', version: '1' }, runs: [],
    gains: [{ scenarioId: stuckScenarioId, gain: incident }, { scenarioId: 'opening', gain: opening }], accepted: true, reason: 'combined mean passed' };
}
test('better opening results cannot compensate for no improvement in the stuck situation', () => {
  for (const gain of [-1, 0, 0.5]) {
    const result = report(gain, 100); requireDoomIncidentImprovement(result, original);
    assert.equal(result.accepted, false); assert.match(result.reason, /stuck position/);
  }
});
test('a large incident improvement cannot compensate for a regression in an original case', () => {
  const result = report(100, -1); requireDoomIncidentImprovement(result, original);
  assert.equal(result.accepted, false); assert.match(result.reason, /original regression/);
});
test('both requirements pass and incomplete or failed comparisons stay rejected', () => {
  const result = report(2, 0); requireDoomIncidentImprovement(result, original); assert.equal(result.accepted, true);
  result.accepted = false; result.reason = 'unfinished run';
  requireDoomIncidentImprovement(result, original); assert.equal(result.accepted, false); assert.equal(result.reason, 'unfinished run');
});
