import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionGate, waitFor } from '../src/execution.ts';

test('ownership is acquired synchronously and cancellation joins cleanup before reuse', async () => {
  const gate = new ExecutionGate();
  let entered!: () => void, finish!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined, cleaned = false;
  const run = gate.run(async current => {
    signal = current;
    entered();
    try { await runtime; } finally { cleaned = true; }
  });
  assert.equal(gate.busy, true);
  assert.throws(() => gate.run(async () => {}), /already in progress/);
  await dispatched;
  const stopped = gate.stop();
  assert.equal(signal!.aborted, true);
  assert.equal(cleaned, false);
  assert.equal(gate.busy, true);
  finish();
  await stopped; await run;
  assert.equal(cleaned, true);
  assert.equal(gate.busy, false);
  await gate.run(async current => { assert.equal(current.aborted, false); });
});
test('synchronous failure is observable and releases ownership', async () => {
  const gate = new ExecutionGate();
  const failure = new Error('adapter failed');
  const run = gate.run(() => { throw failure; });
  const joined = gate.join();
  await Promise.all([assert.rejects(run, error => error === failure), assert.rejects(joined, error => error === failure)]);
  assert.equal(gate.busy, false);
});
test('pacing can be cancelled without waiting for its full duration', async () => {
  const controller = new AbortController();
  const waiting = waitFor(60_000, controller.signal);
  controller.abort();
  await waiting;
  await waitFor(60_000, controller.signal);
  await assert.rejects(waitFor(NaN, controller.signal), /Invalid pacing/);
});
