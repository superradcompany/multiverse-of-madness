import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionPrefetch } from '../src/decision-prefetch.ts';

test('one speculative decision can be consumed once and cannot replace an in-flight request', async () => {
  const slot = new DecisionPrefetch<string, number>(), signal = new AbortController().signal;
  let finish!: (value: number) => void;
  assert.equal(slot.start('goal-a', () => new Promise(resolve => { finish = resolve; }), signal), true);
  assert.equal(slot.start('goal-b', async () => 99, signal), false);
  await Promise.resolve(); finish(7);
  assert.equal(await slot.take(key => key === 'goal-a', signal), 7);
  assert.equal(slot.pending, false);
  assert.equal(await slot.take(() => true, signal), undefined);
});

test('discard signals cancellation and joins dispatched provider cleanup', async () => {
  const slot = new DecisionPrefetch<string, number>();
  let finish!: () => void, dispatched = false, cancelled = false;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  slot.start('a', async signal => {
    dispatched = true; signal.addEventListener('abort', () => { cancelled = true; });
    await cleanup; signal.throwIfAborted(); return 1;
  }, new AbortController().signal);
  await Promise.resolve(); assert.equal(dispatched, true);
  let joined = false; const discarding = slot.discard().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(cancelled, true); assert.equal(joined, false);
  finish(); await discarding; assert.equal(slot.pending, false);
});

test('validity is rechecked after waiting and a consuming owner can cancel a different original signal', async () => {
  const slot = new DecisionPrefetch<string, number>();
  let finish!: (value: number) => void, current = true;
  slot.start('a', () => new Promise(resolve => { finish = resolve; }), new AbortController().signal);
  await Promise.resolve(); const taking = slot.take(() => current, new AbortController().signal);
  current = false; finish(1); assert.equal(await taking, undefined);
  const owner = new AbortController();
  slot.start('b', async signal => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); signal.throwIfAborted(); return 2; }, new AbortController().signal);
  await Promise.resolve(); const cancelled = slot.take(() => true, owner.signal);
  owner.abort(); await assert.rejects(cancelled, /abort/i); assert.equal(slot.pending, false);
});
