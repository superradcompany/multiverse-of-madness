import assert from 'node:assert/strict';
import { join } from 'node:path';
import { routeDecision, runTrials, createScopedGoal, advanceScopedGoal, decodeScopedGoal, requirePlanCapabilities, UnsupportedGameCapabilities, trainingMenu, selectedTrainingScenarios, type TrainingCatalog, type Trial, type ScopedGoalRules, type GameCapabilities } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';

// Package-boundary fixture, not a game, model call, or VM qualification.
const capabilities: GameCapabilities = { observations: 'visual', exactFork: false, checkpoint: false, restore: false, detached: false, render: true };
requirePlanCapabilities({ id: 'ordinary-move', requires: ['render'] }, capabilities);
assert.throws(() => requirePlanCapabilities({ id: 'rewind', requires: ['restore'] }, capabilities), UnsupportedGameCapabilities);
const training: TrainingCatalog<{ position: number }> = { format: 1, revision: { id: 'practice', version: '1' }, maximumSelection: 1,
  scenarios: [{ id: 'seen', seed: 'fixed', label: 'Observed position', description: 'Recorded failure', input: { position: 4 } }] };
assert.equal(trainingMenu(training).scenarios[0]!.id, 'seen');
assert.equal(selectedTrainingScenarios(training, { catalog: training.revision, scenarioIds: ['seen'], reason: 'Revisit failure' })[0]!.input.position, 4);
const routed = routeDecision([{ id: 'a', probability: .6 }, { id: 'b', probability: .4 }],
  { threshold: .75, breadth: 2 }, { confidence: .6, manual: false, stalled: false, retries: 0 });
assert.equal(routed.mode, 'uncertain');
let settled = 0;
const trials: Trial[] = routed.trials.map(candidate => {
  let turn = 0;
  return { id: candidate.id, baseline: { sequence: 0, elapsed: 0, unit: 'turns' }, duration: { amount: 2, unit: 'turns' },
    clock: () => ({ sequence: turn, elapsed: turn, unit: 'turns' }), terminal: () => false,
    advance: async (_remaining, signal) => { signal.throwIfAborted(); turn++; }, settled: () => { settled++; } };
});
const results = await runTrials(trials, new AbortController().signal);
assert.deepEqual(results.map(result => [result.id, result.status, result.elapsed.amount]), [['a', 'completed', 2], ['b', 'completed', 2]]);
assert.equal(settled, 2);
const record = { revision: contentRevision('package-consumer', { format: 1 }), results };
const file = join(process.cwd(), 'receipt.json');
const store = new JsonFileStore(file, value => value);
await store.save(record); await store.flush();
const reopened = new JsonFileStore(file, value => value);
assert.deepEqual(await reopened.load(), record);
const goalRules: ScopedGoalRules<string> = { version: { id: 'consumer-target', version: '1' }, maxDuration: 4,
  parseTarget: value => { if (typeof value !== 'string') throw new Error('Expected target'); return value; },
  hasEvidence: reference => reference === 'observation-1' };
const frame = { scope: { id: 'run', version: 'scene-1' }, context: { id: 'objective', version: '1' },
  source: { id: 'strategy', version: '1' }, clock: { unit: 'turns', value: 0 } };
const goal = createScopedGoal('short-term', { instruction: 'Reach the observed route', reason: 'Observed repeated failure',
  evidence: ['observation-1'], duration: 2, target: 'route' }, frame, goalRules);
const goalFile = join(process.cwd(), 'goal.json');
await new JsonFileStore(goalFile, value => decodeScopedGoal(value, goalRules)).save(goal);
const savedGoal = await new JsonFileStore(goalFile, value => decodeScopedGoal(value, goalRules)).load();
assert.ok(savedGoal);
assert.equal(advanceScopedGoal(savedGoal, { ...frame, clock: { unit: 'turns', value: 2 } }, {}, goalRules,
  () => { throw new Error('Expired goals cannot be graded'); }).status, 'expired');
console.log('External consumer passed: public types, routing, trials, durable receipts and scoped-goal expiry.');
