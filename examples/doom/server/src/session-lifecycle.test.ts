import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

const options = { threshold: 0.75, horizon: 7, branches: 2, paceMs: 0 };

test('failed publication preserves the Doom comparison and all runtimes for a retried promotion', async () => {
  const source = new Runtime('source'), session = new Session({ decide: async () => decision }, options);
  await session.initialize(source); session.step(); await session.idle();
  const before = session.checkpoint(), selected = before.experiments[0]!.id;
  session.setPersistence(async checkpoint => { if (checkpoint.view.mainId === selected) throw new Error('write failed'); });
  await assert.rejects(session.promote(selected), /write failed/);
  const after = session.checkpoint();
  assert.equal(after.view.mainId, 'source'); assert.equal(after.view.stage, 'choosing');
  assert.equal(source.destroyed, false);
  assert.deepEqual(after.experiments, before.experiments);
  assert.deepEqual(after.view.comparison, before.view.comparison);
  assert.deepEqual(after.worlds.map(world => [world.view.id, world.view.role, world.identity]), before.worlds.map(world => [world.view.id, world.view.role, world.identity]));
  session.setPersistence(async () => {});
  await session.promote(selected);
  assert.equal(session.snapshot().mainId, selected); assert.equal(source.destroyed, true);
});

test('same-millisecond comparison batches have distinct identities and preserve archived worlds', async () => {
  const previousNow = Date.now;
  Date.now = () => 1000;
  try {
    const source = new Runtime('source'), session = new Session({ decide: async () => decision }, options);
    await session.initialize(source); session.step(); await session.idle();
    const first = session.snapshot().worlds.filter(world => world.role === 'experiment').map(world => world.id);
    await session.promote('source');
    session.step(); await session.idle();
    assert.equal(session.snapshot().error, undefined);
    const second = session.snapshot().worlds.filter(world => world.role === 'experiment').map(world => world.id);
    assert.ok(second.every(id => !first.includes(id)));
    assert.ok(first.every(id => session.snapshot().worlds.some(world => world.id === id && world.role === 'archived')));
  } finally { Date.now = previousNow; }
});

test('lost fork acknowledgment remains journaled and the existing child resumes without creating another batch', async () => {
  const source = new Runtime('source'), session = new Session({ decide: async () => decision }, options);
  const children = new Map<string, Runtime>();
  let dispatched = 0;
  source.branch = async ids => { dispatched++; children.set(ids[0]!, new Runtime(ids[0]!, await source.state())); throw new Error('lost acknowledgment'); };
  await session.initialize(source); session.step(); await session.idle();
  assert.match(session.snapshot().error!, /lost acknowledgment/);
  assert.equal(session.checkpoint().pendingFork?.ids.length, 2);
  assert.equal(session.snapshot().worlds.length, 1);
  await session.reconcileFork(async id => children.get(id));
  assert.equal(session.snapshot().error, undefined);
  assert.equal(session.checkpoint().pendingFork, undefined);
  assert.equal(session.snapshot().stage, 'exploring');
  session.step(); await session.idle();
  assert.equal(dispatched, 1);
  assert.equal(session.snapshot().stage, 'choosing');
  assert.equal(session.snapshot().worlds.find(w => w.role === 'experiment')!.state.tick, 42);
});

test('failed fork publication restores Doom metadata and recovers acknowledged physical children after restart', async () => {
  const source = new Runtime('source'), session = new Session({ decide: async () => decision }, options);
  const children = new Map<string, Runtime>();
  source.branch = async ids => { for (const id of ids) children.set(id, new Runtime(id, await source.state())); return [...children.values()]; };
  await session.initialize(source);
  let writes = 0;
  session.setPersistence(async () => { if (++writes === 3) throw new Error('publication failed'); });
  session.step(); await session.idle();
  const saved = session.checkpoint();
  assert.match(saved.view.error!, /publication failed/);
  assert.equal(saved.worlds.length, 1); assert.equal(saved.experiments.length, 0); assert.equal(saved.baseline, undefined);
  assert.equal(saved.pendingFork?.created?.length, 2);
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async () => source, async id => children.get(id));
  assert.equal(restored.checkpoint().pendingFork, undefined);
  assert.equal(restored.checkpoint().experiments.length, 2);
  assert.equal(restored.snapshot().stage, 'exploring');
  assert.ok(restored.snapshot().worlds.filter(w => w.role === 'experiment').every(w => w.trial?.total === 7));
});

test('fork recovery checks the full observed game state instead of only matching ticks', async () => {
  const source = new Runtime('source'), session = new Session({ decide: async () => decision }, options);
  await session.initialize(source);
  const saved = session.checkpoint();
  saved.pendingFork = { parentId: 'source', ids: ['wrong'], actions: ['advance'], baseline: await source.state() };
  const changed = new Runtime('wrong', { ...await source.state(), health: 40 });
  const restored = new Session({ decide: async () => decision }, options);
  await assert.rejects(restored.restore(saved, async () => source, async () => changed), /does not match the captured game state/);
  assert.equal(restored.checkpoint().worlds.length, 1);
  assert.ok(restored.checkpoint().pendingFork);
});

test('skills changed during VM admission cannot be stamped onto an older fork judgment', async () => {
  const { defaultVmSettings } = await import('../../contracts/src/vm.ts');
  let entered!: () => void, finish!: () => void;
  const admission = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const source = new Runtime('source') as Runtime & Required<Pick<import('./runtime.ts').WorldRuntime, 'resources'>>;
  source.resources = async () => { entered(); await release; return defaultVmSettings.defaults; };
  const skills: string[][] = [];
  const session = new Session({ decide: async (_state, _guide, _history, _signal, _experience, _ticks, context) => {
    skills.push(context?.skills?.map(skill => skill.name) ?? []);
    return structuredClone(decision);
  } }, options);
  session.setVmSettings({ get settings() { return defaultVmSettings; } } as import('./vm-settings.ts').VmSettingsStore);
  await session.initialize(source); session.step(); await admission;
  session.saveSkill({ name: 'Updated after judgment', instructions: 'Prefer health before combat.', enabled: true });
  finish(); await session.idle();
  assert.equal(session.snapshot().error, undefined);
  assert.deepEqual(skills[0], []);
  assert.equal(skills.length, 3);
  assert.ok(skills.slice(1).every(names => names.includes('Updated after judgment')));
});

test('automatic promotion advances the winning VM before loser cleanup finishes, and pause joins cleanup', async () => {
  const source = new Runtime('source'), children = new Map<string, Runtime>();
  source.branch = async ids => {
    const state = await source.state();
    return ids.map(id => { const child = new Runtime(id, structuredClone(state)); children.set(id, child); return child; });
  };
  const session = new Session({ decide: async () => structuredClone(decision) }, options);
  await session.initialize(source); session.step(); await session.idle();
  const endTick = session.snapshot().worlds.find(world => world.role === 'experiment')!.state.tick;
  let finish!: () => void, advanced!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const continued = new Promise<void>(resolve => { advanced = resolve; });
  source.destroy = async () => { await blocked; source.destroyed = true; };
  let paused: Promise<void> | undefined;
  session.setRecorder(async world => {
    if (world.role === 'main' && world.state.tick > endTick && !paused) {
      assert.equal(source.destroyed, false);
      paused = session.pause(); advanced();
    }
  });
  session.setForkThreshold(0); session.resume();
  try {
    await continued;
    const selected = session.snapshot().mainId;
    assert.ok(children.has(selected)); assert.equal(children.get(selected)!.destroyed, false);
    assert.ok(session.checkpoint().cleanup?.some(entry => entry.id === source.id));
    let idle = false;
    void session.idle().then(() => { idle = true; });
    await Promise.resolve(); assert.equal(idle, false);
  } finally { finish(); await session.pause(); await paused; }
  assert.equal(source.destroyed, true); assert.deepEqual(session.checkpoint().cleanup, []);
  assert.equal(session.snapshot().error, undefined);
});
