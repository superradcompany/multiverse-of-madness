import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrials, type Trial } from '../src/trials.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(id: string, total = 3) {
  const state = { turn: 0, points: 0, finished: false, settled: false, remaining: total };
  const trial: Trial = {
    id, baseline: { sequence: 0, elapsed: 0, unit: 'turns' }, duration: { amount: total, unit: 'turns' },
    clock: () => ({ sequence: state.turn, elapsed: state.turn, unit: 'turns' }),
    terminal: () => state.finished,
    advance: async () => { state.turn++; state.points += 2; },
    progress: remaining => { state.remaining = remaining.amount; },
    settled: () => { state.settled = true; },
  };
  return { trial, state };
}
test('equal simulation budgets run independently of sibling model latency', async () => {
  const slow = fixture('slow'), fast = fixture('fast');
  const pendingModel = deferred(), fastFinished = deferred();
  slow.trial.advance = async () => { await pendingModel.promise; slow.state.turn++; };
  fast.trial.settled = () => { fastFinished.resolve(); };
  const running = runTrials([slow.trial, fast.trial], new AbortController().signal);
  await fastFinished.promise;
  assert.equal(fast.state.turn, 3);
  assert.equal(slow.state.turn, 0);
  pendingModel.resolve();
  const result = await running;
  assert.deepEqual(result.map(r => [r.status, r.elapsed.amount, r.remaining.amount]), [['completed', 3, 0], ['completed', 3, 0]]);
});
test('pause fences dispatched operations and resumes only the remaining budget', async () => {
  const { trial, state } = fixture('selected');
  const dispatched = deferred(), finishInput = deferred(), controller = new AbortController();
  trial.advance = async () => { dispatched.resolve(); await finishInput.promise; state.turn++; };
  let returned = false;
  const running = runTrials([trial], controller.signal).then(result => { returned = true; return result; });
  await dispatched.promise;
  controller.abort();
  await Promise.resolve();
  assert.equal(returned, false);
  assert.equal(state.settled, false);
  finishInput.resolve();
  assert.equal((await running)[0]!.status, 'cancelled');
  assert.equal(state.turn, 1);
  assert.equal(state.remaining, 2);
  assert.equal(state.settled, true);
  trial.advance = async () => { state.turn++; };
  await runTrials([trial], new AbortController().signal);
  assert.equal(state.turn, 3);
});
test('first failure cancels siblings and joins them without replacing the cause', async () => {
  const first = fixture('slow-first'), second = fixture('failed-second');
  const input = deferred(), failureReady = deferred(), original = new Error('model unavailable');
  let siblingSignal: AbortSignal | undefined;
  first.trial.advance = async (_remaining, signal) => {
    siblingSignal = signal;
    await input.promise;
    first.state.turn++;
    signal.throwIfAborted();
  };
  second.trial.advance = async () => { failureReady.resolve(); throw original; };
  const running = runTrials([first.trial, second.trial], new AbortController().signal);
  const rejected = assert.rejects(running, error => error === original);
  await failureReady.promise;
  await Promise.resolve();
  assert.equal(siblingSignal?.aborted, true);
  assert.equal(first.state.settled, false);
  input.resolve();
  await rejected;
  assert.equal(first.state.settled, true);
  assert.equal(second.state.settled, true);
});
test('terminal worlds stop early while siblings finish their budgets', async () => {
  const ended = fixture('terminal'), other = fixture('continuing');
  ended.trial.advance = async () => { ended.state.turn++; ended.state.finished = true; };
  const result = await runTrials([ended.trial, other.trial], new AbortController().signal);
  assert.equal(result[0]!.status, 'terminal');
  assert.equal(result[0]!.remaining.amount, 2);
  assert.equal(other.state.turn, 3);
});
test('invalid batches dispatch nothing and frozen or overshooting adapters fail explicitly', async () => {
  const first = fixture('a'), unequal = fixture('b', 4);
  await assert.rejects(runTrials([first.trial, unequal.trial], new AbortController().signal), /equal simulation budgets/);
  assert.equal(first.state.turn, 0);
  const frozen = fixture('frozen');
  let calls = 0;
  frozen.trial.advance = async () => { calls++; };
  await assert.rejects(runTrials([frozen.trial], new AbortController().signal, { maxIdleTransitions: 3 }), /idle-transition budget/);
  assert.equal(calls, 3);
  assert.equal(frozen.state.settled, true);
  const overshoot = fixture('overshoot');
  overshoot.trial.advance = async () => { overshoot.state.turn += 4; };
  await assert.rejects(runTrials([overshoot.trial], new AbortController().signal), /exceeded its simulation budget/);
  assert.equal(overshoot.state.settled, true);
});
test('seconds converted from fixed ticks tolerate rounding but not an extra frame', async () => {
  const trial = fixture('frames');
  const base = 999999;
  let tick = base;
  trial.trial.baseline.elapsed = base / 35;
  trial.trial.baseline.sequence = base;
  trial.trial.baseline.unit = 'seconds';
  trial.trial.duration.amount = 7 / 35;
  trial.trial.duration.unit = 'seconds';
  trial.trial.clock = () => ({ sequence: tick, elapsed: tick / 35, unit: 'seconds' });
  trial.trial.advance = async () => { tick++; };
  await runTrials([trial.trial], new AbortController().signal);
  assert.equal(tick, base + 7);
});

test('trial horizons are pinned while controls change during execution', async () => {
  const { trial, state } = fixture('pinned');
  trial.advance = async () => {
    state.turn++;
    trial.duration.amount = 100;
    trial.baseline.elapsed = state.turn;
    trial.baseline.sequence = state.turn;
  };
  const result = await runTrials([trial], new AbortController().signal);
  assert.equal(state.turn, 3);
  assert.equal(result[0]!.elapsed.amount, 3);
});
