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

test('early invalidation starts cancellation but retains ownership until cleanup joins', async () => {
  const slot = new DecisionPrefetch<string, number>(), owner = new AbortController();
  let release!: () => void, cancellations = 0;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  slot.start('old-facts', async signal => {
    signal.addEventListener('abort', () => { cancellations++; });
    await cleanup;
    // Even a provider that returns a value after cancellation cannot revive it.
    return 7;
  }, owner.signal);
  await Promise.resolve();
  assert.equal(slot.invalidate(context => context === 'old-facts'), false);
  assert.equal(slot.invalidate(() => false), true);
  assert.equal(slot.invalidate(() => { throw new Error('Already invalidated'); }), false);
  assert.equal(cancellations, 1);
  assert.equal(slot.pending, true);
  assert.equal(slot.start('new-facts', async () => 8, owner.signal), false);
  let joined = false;
  const taking = slot.take(() => true, owner.signal).then(value => { joined = true; return value; });
  await Promise.resolve(); assert.equal(joined, false);
  release();
  assert.equal(await taking, undefined);
  assert.equal(slot.pending, false);
  assert.equal(slot.invalidate(() => false), false);
});
