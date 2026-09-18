import assert from 'node:assert/strict';
import { join } from 'node:path';
import { routeDecision, runTrials, type Trial } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';

// Package-boundary fixture, not a game, model call, or VM qualification.
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
console.log('External consumer passed: public types, routing, trials, and durable Node receipt.');
