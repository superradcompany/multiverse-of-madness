import '../runtime-env.ts';
import '../build-bridge.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from '../../examples/doom/server/src/session.ts';
import { createWorld, reconnectWorld, recoverPendingWorld } from '../../examples/doom/server/src/runtime.ts';
import { actions, type Decision } from '../../examples/doom/server/src/jev.ts';
import { proposeDoomTemporaryGoal } from '../../examples/doom/server/src/doom-temporary-goal.ts';

// Real VM lifecycle qualification with a scripted decision. This does not measure Jev quality.
const id = `mom-goals-${Date.now()}`, directory = `artifacts/temporary-goals/${id}`;
const runtime = await createWorld(id), baseline = await runtime.state();
const session = new Session({ decide: async (state, _objective, _history, _signal, _experience, _ticks, context) => ({
  action: 'advance', confidence: 0, probabilities: Object.fromEntries(Object.keys(actions).map(key => [key, 1 / Object.keys(actions).length])) as Decision['probabilities'],
  priority: 'exploration', latencyMs: 0, model: 'scripted-lifecycle-check',
  temporaryGoal: proposeDoomTemporaryGoal({ key: 'first-kill', instruction: 'Defeat an observed enemy when feasible', reason: 'Lifecycle qualification',
    evidence: ['current-state'], duration: 70, target: { kind: 'kills', minimum: state.kills + 1 } }, context?.temporaryGoal, state),
}) }, { threshold: 1, horizon: 35, branches: 2, paceMs: 0 });
const restored = new Session({ decide: async () => { throw new Error('Reconnect must not ask a model'); } });
let paused: Promise<void> | undefined;
let owned: string[] = [id];
try {
  await session.initialize(runtime); session.setPlanningMode('actions');
  session.setRecorder(async world => {
    if (world.role === 'experiment' && world.state.tick > baseline.tick) paused ??= session.pause();
  });
  session.resume(); await session.idle(); await paused;
  assert.equal(session.snapshot().error, undefined);
  const saved = session.checkpoint(); owned = saved.worlds.map(world => world.view.id);
  assert.equal(saved.version, 3);
  const source = saved.worlds.find(world => world.view.id === id)!;
  const children = saved.worlds.filter(world => world.view.role === 'experiment');
  assert.equal(children.length, 2); assert.deepEqual(await runtime.state(), baseline);
  for (const child of children) {
    assert.equal(child.view.temporaryGoal!.record.id, source.view.temporaryGoal!.record.id);
    assert.equal(child.view.temporaryGoal!.record.expiresAt, baseline.tick + 70);
  }
  await restored.restore(JSON.parse(JSON.stringify(saved)), reconnectWorld);
  for (const world of restored.snapshot().worlds) {
    assert.deepEqual(world.temporaryGoal, saved.worlds.find(item => item.view.id === world.id)!.view.temporaryGoal);
  }
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/checkpoint.json`, JSON.stringify(saved, null, 2));
  await writeFile(`${directory}/reconnected.json`, JSON.stringify(restored.checkpoint(), null, 2));
  console.log('PASS: real VM source and two children retained scoped goals through branching and reconnect; source state unchanged');
} finally {
  await restored.pause(); await session.close();
  if (owned.length === 1) await runtime.destroy().catch(() => {});
}
for (const name of owned) assert.equal(await recoverPendingWorld(name), undefined, `Leaked sandbox ${name}`);
await writeFile(`${directory}/cleanup.json`, JSON.stringify({ destroyed: owned }, null, 2));
console.log(`PASS: all ${owned.length} owned VMs removed`);
