import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessComparisonViewer, type ChessComparisonView } from './comparison-view.ts';
import { ChessWorld } from './runtime.ts';
import type { EvaluationContract } from '@multiverse/gameplay-harness';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

test('comparison replay survives refresh/reopen, marks interrupted playback, and rejects fabricated history', async () => {
  let saved: ChessComparisonView | undefined;
  const store = { flush: async () => {}, load: async () => structuredClone(saved), save: async (value: ChessComparisonView) => { saved = structuredClone(value); } };
  const world = new ChessWorld('recorded'), before = await world.state(), after = await world.step({ san: 'e4' });
  await world.destroy();
  const contract: EvaluationContract<ChessStrategyScenario> = { id: 'host', evaluator: { id: 'host', version: '1' },
    scenarios: [{ id: 'case', seed: 'fixed', input: { saved: before, objective: 'win', player: 'w', plies: 2 } }],
    budget: { simulationUnit: 'plies', limits: { simulation: 2, modelCalls: 2 } }, maxRunMs: 1000,
    acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: 0, maximumCaseRegression: 0 } };
  const viewer = await ChessComparisonViewer.open(store), observer = viewer.observer('proposal', 'proposal');
  await observer.start(contract);
  await observer.progress({ scenarioId: 'case', role: 'baseline', before, state: after, attemptedPlies: 1, trials: [] });
  assert.deepEqual(viewer.snapshot()!.runs[0]!.frames, [before, after]);
  const reopened = await ChessComparisonViewer.open(store);
  assert.equal(reopened.snapshot()!.status, 'interrupted'); assert.equal(reopened.snapshot()!.runs[0]!.status, 'cancelled');
  assert.deepEqual(reopened.snapshot()!.runs[0]!.frames, [before, after]);
  await assert.rejects(observer.progress({ scenarioId: 'case', role: 'baseline', before, state: { ...after, fen: before.fen }, attemptedPlies: 1, trials: [] }), /differs from the observed/);
  await assert.rejects(observer.progress({ scenarioId: 'case', role: 'baseline', before: { ...before, fen: after.fen }, state: after, attemptedPlies: 1, trials: [] }), /starting board differs/);
  const result = viewer.snapshot()!; result.runs[0]!.frames.length = 0;
  assert.equal(viewer.snapshot()!.runs[0]!.frames.length, 2);
  const unavailable = await ChessComparisonViewer.open({ flush: async () => {}, load: async () => { throw new Error('Corrupt presentation cache'); }, save: async () => {} });
  assert.equal(unavailable.snapshot(), undefined);
});
