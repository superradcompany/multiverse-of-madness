import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCurrent } from '../src/decision.ts';

test('a stale judgment is discarded together with the policy context that produced it', async () => {
  let revision = 1;
  const result = await decideCurrent({
    capture: () => ({ revision, goal: revision === 1 ? 'collect' : 'finish' }),
    decide: async context => { revision = 2; return { choice: context.goal }; },
    isCurrent: context => context.revision === revision,
  }, new AbortController().signal);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.context, { revision: 2, goal: 'finish' });
  assert.deepEqual(result.result, { choice: 'finish' });
});
test('persistent edits consume a bounded number of requests and do not return stale results', async () => {
  let calls = 0;
  await assert.rejects(decideCurrent({ capture: () => 0, decide: async () => ++calls, isCurrent: () => false }, new AbortController().signal, 3), /budget exhausted/);
  assert.equal(calls, 3);
});
test('late cancellation discards the completed judgment and provider errors are not retried', async () => {
  const controller = new AbortController();
  let checked = false;
  await assert.rejects(decideCurrent({
    capture: () => 0,
    decide: async () => { controller.abort(); return 'move'; },
    isCurrent: () => { checked = true; return true; },
  }, controller.signal), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(checked, false);
  let calls = 0;
  const failure = new Error('provider unavailable');
  await assert.rejects(decideCurrent({ capture: () => 0, decide: async () => { calls++; throw failure; }, isCurrent: () => true }, new AbortController().signal), error => error === failure);
  assert.equal(calls, 1);
});
