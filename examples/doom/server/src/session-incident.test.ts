import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Session, sessionContinuation } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

const reference = () => `mom-checkpoint-${randomUUID()}:recovery`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(capture: () => Promise<void> = async () => {}) {
  const runtime = new Runtime('incident-main');
  const session = new Session({ decide: async () => ({ ...decision, confidence: 1 }) },
    { threshold: 0, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
  await session.initialize(runtime); session.setPlanningMode('actions');
  session.setPersistence(async () => {});
  session.setCheckpointAdapter({ capture, restore: async () => { throw new Error('not used'); }, remove: async () => {} });
  return { session, runtime };
}

test('incident capture freezes the current world and applied goal without using user recovery slots', async () => {
  let captures = 0;
  const { session, runtime } = await fixture(async () => { captures++; });
  session.queueObjective('Find a safe route out');
  const saved = await session.captureLearningIncident(reference(), new AbortController().signal);
  assert.equal(captures, 1);
  assert.equal(saved.view.objective, 'Find a safe route out');
  assert.equal(saved.view.pendingObjective, undefined);
  assert.deepEqual(saved.worlds.find(w => w.view.id === saved.view.mainId)!.view.state, await runtime.state());
  assert.equal(session.snapshot().recovery?.checkpoints.length, 0);
  session.queueObjective('A later goal');
  assert.equal(saved.view.objective, 'Find a safe route out', 'captured evidence does not change with live settings');
});

test('aborting a queued incident removes it without capturing or stopping gameplay', async () => {
  let captures = 0;
  const { session } = await fixture(async () => { captures++; });
  const entered = deferred(), release = deferred();
  session.setRecorder(async () => { entered.resolve(); await release.promise; void session.pause(); });
  session.resume(); await entered.promise;
  const controller = new AbortController();
  const pending = session.captureLearningIncident(reference(), controller.signal);
  controller.abort(new Error('cancelled incident'));
  await assert.rejects(pending, /cancelled incident/);
  release.resolve(); await session.idle(); await session.pause();
  assert.equal(captures, 0);
  assert.equal(session.snapshot().error, undefined);
});

test('dispatched incident capture is joined before cancellation allows its owner to clean up', async () => {
  const entered = deferred(), release = deferred();
  const { session } = await fixture(async () => { entered.resolve(); await release.promise; });
  const controller = new AbortController(); let finished = false;
  const pending = session.captureLearningIncident(reference(), controller.signal).finally(() => { finished = true; });
  const rejected = assert.rejects(pending, /cancelled incident/);
  await entered.promise; controller.abort(new Error('cancelled incident'));
  await Promise.resolve(); assert.equal(finished, false);
  release.resolve(); await rejected;
  assert.equal(finished, true);
});

test('incident capture waits for a running decision to finish and then lets gameplay continue', async () => {
  const entered = deferred(), release = deferred(); let captured = false, frames = 0;
  const { session } = await fixture(async () => { captured = true; });
  session.setRecorder(async () => {
    frames++;
    if (frames === 1) { entered.resolve(); await release.promise; }
    if (captured) void session.pause();
  });
  session.resume(); await entered.promise;
  const pending = session.captureLearningIncident(reference(), new AbortController().signal);
  assert.equal(captured, false); release.resolve();
  const saved = await pending;
  assert.equal(saved.view.running, true);
  assert.ok(saved.worlds[0]!.view.state.tick > 35);
  await session.idle(); await session.pause();
  assert.ok(frames >= 2);
  assert.equal(session.snapshot().error, undefined);
});

test('invalid references, human control, and state changes during capture are refused', async () => {
  const { session, runtime } = await fixture();
  await assert.rejects(session.captureLearningIncident('arbitrary-snapshot', new AbortController().signal), /Invalid learning checkpoint/);
  await session.takeover(runtime.id);
  await assert.rejects(session.captureLearningIncident(reference(), new AbortController().signal), /Return control to AI/);
  await session.release(runtime.id);
  session.setCheckpointAdapter({ capture: async () => { await runtime.step({ inputs: [], ticks: 1 }); }, restore: async () => runtime, remove: async () => {} });
  await assert.rejects(session.captureLearningIncident(reference(), new AbortController().signal), /changed during/);
});

test('a queued incident captures after manual promotion without another Play click', async () => {
  let captures = 0;
  const { session } = await fixture(async () => { captures++; });
  const control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session.step(); await session.idle();
    assert.ok(session.snapshot().worlds.some(world => world.role === 'experiment'));
    const pending = session.captureLearningIncident(reference(), control.signal);
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Queued capture never reached paused boundary')), 1000); });
    assert.equal(captures, 0);
    session.step(); await session.idle();
    const saved = await Promise.race([pending, deadline]);
    assert.equal(captures, 1); assert.equal(saved.view.running, false);
    assert.equal(session.snapshot().running, false);
    assert.equal(saved.worlds.find(world => world.view.id === saved.view.mainId)!.view.state.tick,
      session.snapshot().worlds.find(world => world.id === session.snapshot().mainId)!.state.tick);
    assert.equal(session.snapshot().error, undefined);
  } finally { clearTimeout(timer); control.abort(); await session.close(); }
});


test('evaluation continuation keeps failed-route knowledge and stall age while using the new policy', async () => {
  const { session, runtime } = await fixture();
  const saved = session.checkpoint(), original = saved.worlds[0]!;
  original.stats!.ticks = 7000; original.stats!.lastProgressTick = 0;
  original.stats!.visited.push('1:1:2:3:0');
  original.history.push({ ...original.view.state, tick: 10 });
  const seed = sessionContinuation(saved);
  const trial = new Session({ decide: async () => ({ ...decision, confidence: 1 }) }, { threshold: 0, horizon: 7, branches: 2, paceMs: 0 });
  trial.setPlanningMode('actions');
  await trial.initialize(new Runtime('restored-incident', await runtime.state()), seed);
  assert.equal(trial.snapshot().stats!.stalledSeconds, 1);
  assert.equal(trial.snapshot().stats!.seconds, 200);
  assert.equal(trial.snapshot().stats!.cells, 2);
  seed.stats!.visited.length = 0;
  assert.equal(trial.snapshot().stats!.cells, 2, 'trial owns a frozen copy');
  trial.step(); await trial.idle();
  if (trial.snapshot().stage === 'choosing') { trial.step(); await trial.idle(); }
  assert.ok(trial.snapshot().stats!.seconds > 200);
  assert.equal(trial.snapshot().stats!.cells, 2, 'revisiting the same location is not novel progress');
  await trial.close();
});
