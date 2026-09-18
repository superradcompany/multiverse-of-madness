import './runtime-env.ts';
import './build-bridge.ts';
import assert from 'node:assert/strict';
import { Session } from '../examples/doom/server/src/session.ts';
import { SessionStore } from '../examples/doom/server/src/persistence.ts';
import { createWorld, reconnectWorld, recoverPendingWorld, destroyWorld } from '../examples/doom/server/src/runtime.ts';
import { actions, type Decision } from '../examples/doom/server/src/jev.ts';

// Failure-injection qualification with real detached VMs and a deterministic
// decision fixture. This is not an inference/quality evaluation.
const decision: Decision = { action: 'advance', confidence: 0.2, priority: 'exploration', latencyMs: 0, model: 'fork-recovery-fixture',
  probabilities: Object.fromEntries(Object.keys(actions).map(action => [action, 1 / 8])) as Decision['probabilities'] };
const store = new SessionStore('.cache/fork-recovery-smoke.json');
const session = new Session({ decide: async () => structuredClone(decision) }, { threshold: 0.75, horizon: 7, branches: 2, frameTicks: 1, paceMs: 0 });
if (process.argv[2] === 'create') {
  let injected = false;
  try {
    await session.initialize(await createWorld(`mom-fork-recovery-smoke-${Date.now()}`));
    session.setPersistence(async checkpoint => {
      await store.save(checkpoint);
      if (!injected && checkpoint.pendingFork?.created?.length === 2) {
        injected = true;
        throw new Error('Injected host failure after runtime creation');
      }
    });
    session.step(); await session.idle();
    assert.equal(injected, true);
    assert.match(session.snapshot().error!, /Injected host failure/);
    const saved = session.checkpoint();
    assert.equal(saved.worlds.length, 1); assert.equal(saved.experiments.length, 0);
    assert.equal(saved.pendingFork?.created?.length, 2);
    await store.save(saved); await store.flush();
    console.log('Saved interrupted fork with two real detached children; exiting the host before adoption.');
    process.exit(0);
  } catch (error) {
    await session.pause();
    for (const id of session.checkpoint().pendingFork?.ids ?? []) {
      const child = await recoverPendingWorld(id);
      if (child) await destroyWorld(id, child.identity);
    }
    await session.close();
    throw error;
  }
} else if (process.argv[2] === 'reconnect') {
  const saved = await store.load(); assert.ok(saved?.pendingFork?.created?.length);
  const expected = saved.pendingFork.created;
  let recovered = 0;
  try {
    await session.restore(saved, reconnectWorld, async id => { recovered++; return recoverPendingWorld(id); }, destroyWorld);
    session.setPersistence(checkpoint => store.save(checkpoint));
    assert.equal(recovered, 2);
    assert.equal(session.checkpoint().pendingFork, undefined);
    assert.equal(session.snapshot().stage, 'exploring');
    for (const reference of expected) {
      const world = session.checkpoint().worlds.find(world => world.view.id === reference.id)!;
      assert.equal(world.identity, reference.identity);
      assert.deepEqual(world.view.state, saved.pendingFork.baseline);
      assert.equal(world.frame, saved.worlds[0]!.frame);
    }
    session.step(); await session.idle();
    assert.equal(session.snapshot().error, undefined);
    assert.equal(session.snapshot().stage, 'choosing');
    for (const reference of expected) assert.equal(session.snapshot().worlds.find(world => world.id === reference.id)!.state.tick, saved.pendingFork.baseline!.tick + 7);
    session.step(); await session.idle();
    assert.ok(expected.some(reference => reference.id === session.snapshot().mainId));
    console.log('PASS: a new host adopted the exact child identities and state/frame, completed their trials and promoted one winner.');
  } finally {
    await session.close();
    for (const reference of expected) await destroyWorld(reference.id, reference.identity);
  }
} else throw new Error('Expected create or reconnect');
