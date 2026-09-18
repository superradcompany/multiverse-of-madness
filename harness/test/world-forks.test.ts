import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldForks, type ForkIntent, type WorldForkPorts } from '../src/world-forks.ts';
import { WorldLifecycle, type WorldMetadata } from '../src/world-lifecycle.ts';

type Intent = ForkIntent & { baseline: number; turns: number };
class Runtime {
  constructor(readonly id: string, readonly identity = `physical:${id}`, readonly turn = 7) {}
  async destroy() { assert.fail('fork publication must not destroy source or recoverable children'); }
}
type World = { meta: WorldMetadata; runtime?: Runtime; turns: number };
const wrap = (runtime: Runtime, role: WorldMetadata['role']): World => ({ meta: { id: runtime.id, role, controller: 'ai', status: 'paused' }, runtime, turns: 0 });
function fixture() {
  let pending: Intent | undefined;
  let trials: string[] = [];
  const created = new Map<string, Runtime>(), snapshots: Array<{ pending?: Intent; worlds: string[] }> = [];
  let forks = 0;
  const lifecycle = new WorldLifecycle<World, Runtime>({ metadata: w => w.meta, persist: async () => {} });
  lifecycle.register(wrap(new Runtime('root'), 'main')); lifecycle.mainId = 'root';
  const ports: WorldForkPorts<Intent, World, Runtime> = {
    pending: () => pending,
    setPending: intent => { pending = intent; },
    persist: async () => { snapshots.push(structuredClone({ pending, worlds: [...lifecycle.worlds.keys()] })); },
    fork: async (_source, ids) => { forks++; const children = ids.map(id => new Runtime(id)); for (const child of children) created.set(child.id, child); return children.reverse(); },
    attach: async (runtime, _source, intent) => {
      assert.equal(runtime.turn, intent.baseline, 'restored child must match the captured state');
      return wrap(runtime, 'experiment');
    },
    stage: (children, _source, intent) => {
      const before = trials;
      for (const child of children) child.turns = intent.turns;
      trials = [...trials, ...children.map(w => w.meta.id)];
      return () => { trials = before; };
    },
  };
  const coordinator = new WorldForks(lifecycle, ports);
  const intent: Intent = { parentId: 'root', ids: ['a', 'b'], baseline: 7, turns: 3 };
  return { lifecycle, ports, coordinator, intent, created, snapshots, trials: () => trials, forks: () => forks };
}

test('fork creation journals intent and physical identities before publishing complete children', async () => {
  const f = fixture();
  const result = await f.coordinator.create(f.intent);
  assert.deepEqual(result.map(w => w.meta.id), ['a', 'b']);
  assert.deepEqual(result.map(w => w.turns), [3, 3]);
  assert.equal(f.lifecycle.mainId, 'root'); assert.equal(f.lifecycle.world('root').runtime!.turn, 7);
  assert.deepEqual(f.snapshots[0]!.worlds, ['root']);
  assert.deepEqual(f.snapshots[0]!.pending?.ids, ['a', 'b']);
  assert.equal(f.snapshots[0]!.pending?.parentIdentity, 'physical:root');
  assert.deepEqual(f.snapshots[1]!.pending?.created?.map(ref => ref.identity).sort(), ['physical:a', 'physical:b']);
  assert.equal(f.snapshots.at(-1)!.pending, undefined);
  assert.equal(f.ports.pending(), undefined);
});

test('unknown provider failure retains intent and restart adopts only existing children without re-forking', async () => {
  const f = fixture();
  f.ports.fork = async () => { f.created.set('a', new Runtime('a')); throw new Error('lost acknowledgment'); };
  await assert.rejects(f.coordinator.create(f.intent), /lost acknowledgment/);
  assert.deepEqual([...f.lifecycle.worlds.keys()], ['root']);
  assert.deepEqual(f.ports.pending()?.ids, ['a', 'b']);
  await assert.rejects(f.coordinator.create(f.intent), /Reconcile/);
  const recovered = await f.coordinator.reconcile(async id => f.created.get(id));
  assert.deepEqual(recovered.map(w => w.meta.id), ['a']);
  assert.equal(f.ports.pending(), undefined); assert.deepEqual(f.trials(), ['a']);
});

test('failed final publication restores registry and trial metadata while keeping exact recoverable identities', async () => {
  const f = fixture(); let count = 0;
  const save = f.ports.persist;
  f.ports.persist = async () => { if (++count === 3) throw new Error('disk failure'); await save(); };
  await assert.rejects(f.coordinator.create(f.intent), /disk failure/);
  assert.deepEqual([...f.lifecycle.worlds.keys()], ['root']);
  assert.deepEqual(f.trials(), []);
  assert.equal(f.ports.pending()?.created?.length, 2);
  f.ports.persist = save;
  await f.coordinator.reconcile(async id => f.created.get(id));
  assert.equal(f.forks(), 1); assert.equal(f.lifecycle.worlds.size, 3);
  assert.equal(f.ports.pending(), undefined);
});

test('physical replacement and state mismatch refuse adoption and keep the recovery record', async () => {
  for (const failure of ['identity', 'state'] as const) {
    const f = fixture();
    f.ports.attach = async () => { throw new Error('first attach failed'); };
    await assert.rejects(f.coordinator.create(f.intent), /first attach failed/);
    f.ports.attach = async (runtime, _source, intent) => { assert.equal(runtime.turn, intent.baseline, 'wrong state'); return wrap(runtime, 'experiment'); };
    await assert.rejects(f.coordinator.reconcile(async id => new Runtime(id, failure === 'identity' ? `replacement:${id}` : `physical:${id}`, failure === 'state' ? 9 : 7)), failure === 'identity' ? /replaced/ : /wrong state/);
    assert.equal(f.lifecycle.worlds.size, 1); assert.ok(f.ports.pending());
  }
});

test('reconciliation preserves already-published children from historical partial journals', async () => {
  const f = fixture();
  const existing = wrap(new Runtime('a'), 'experiment'); existing.turns = 2;
  f.lifecycle.register(existing); f.ports.setPending(f.intent);
  await f.coordinator.reconcile(async id => id === 'b' ? new Runtime('b') : assert.fail('already connected'));
  assert.equal(f.lifecycle.world('a'), existing); assert.equal(existing.turns, 2);
  assert.deepEqual(f.trials(), ['b']);
});

test('cancellation before dispatch clears an empty intent and cancellation after dispatch joins publication', async () => {
  const first = fixture(), before = new AbortController();
  const save = first.ports.persist;
  first.ports.persist = async () => { await save(); before.abort(); };
  assert.deepEqual(await first.coordinator.create(first.intent, before.signal), []);
  assert.equal(first.forks(), 0); assert.equal(first.ports.pending(), undefined);
  const f = fixture(), after = new AbortController();
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  f.ports.fork = async () => { started(); await release; return [new Runtime('a'), new Runtime('b')]; };
  const creating = f.coordinator.create(f.intent, after.signal);
  await entered; after.abort();
  let joined = false; const joining = f.coordinator.join().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false);
  assert.throws(() => f.coordinator.create(f.intent), /already in progress/);
  finish(); await creating; await joining;
  assert.equal(f.lifecycle.worlds.size, 3); assert.equal(f.ports.pending(), undefined);
});

test('unsupported branching, duplicate IDs and aliased runtimes cannot corrupt the source', async () => {
  const unsupported = fixture(); unsupported.ports.fork = undefined;
  await assert.rejects(unsupported.coordinator.create(unsupported.intent), /does not support/);
  assert.equal(unsupported.snapshots.length, 0);
  const duplicate = fixture(); duplicate.intent.ids = ['a', 'a'];
  await assert.rejects(duplicate.coordinator.create(duplicate.intent), /unique/);
  assert.equal(duplicate.snapshots.length, 0);
  const aliased = fixture(); aliased.ports.fork = async () => [new Runtime('a', 'physical:root'), new Runtime('b')];
  await assert.rejects(aliased.coordinator.create(aliased.intent), /another world/);
  assert.equal(aliased.lifecycle.worlds.size, 1); assert.ok(aliased.ports.pending());
});


test('definitively missing children can be retired during recovery without recreating them', async () => {
  const f = fixture();
  f.ports.setPending({ ...f.intent, created: [{ id: 'a', identity: 'physical:a' }, { id: 'b', identity: 'physical:b' }] });
  const survivors = await f.coordinator.reconcile(async id => id === 'a' ? new Runtime('a') : undefined);
  assert.deepEqual(survivors.map(world => world.meta.id), ['a']);
  assert.equal(f.ports.pending(), undefined);
  assert.equal(f.forks(), 0);
});


test('fork inputs are captured before persistence while provider methods retain their receiver', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const persist = f.ports.persist;
  let first = true;
  f.ports.persist = async () => { await persist(); if (first) { first = false; entered(); await wait; } };
  f.ports.fork = async function (this: typeof f.ports, _source, ids) {
    assert.deepEqual(this.pending()?.ids, ['a', 'b']);
    return ids.map(id => new Runtime(id));
  };
  const creating = f.coordinator.create(f.intent);
  await writing;
  f.intent.ids = ['different']; f.intent.turns = 99;
  release();
  const children = await creating;
  assert.deepEqual(children.map(world => world.meta.id), ['a', 'b']);
  assert.deepEqual(children.map(world => world.turns), [3, 3]);
});


test('the next fork waits for background retirement and refuses unresolved deletion failures', async () => {
  const f = fixture();
  const source = f.lifecycle.world('root').runtime!;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  source.destroy = async () => { await blocked; };
  f.lifecycle.register(wrap(new Runtime('winner'), 'experiment'));
  await f.lifecycle.promote('winner', { cleanup: 'background' });
  const creation = f.coordinator.create({ ...f.intent, parentId: 'winner' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.forks(), 0);
  finish(); await creation;
  assert.equal(f.forks(), 1);
  assert.equal(f.lifecycle.cleanup.length, 0);
  f.lifecycle.cleanup.push({ id: 'failed', identity: 'physical:failed' });
  await assert.rejects(f.coordinator.create({ ...f.intent, parentId: 'winner', ids: ['c'] }), /pending world cleanup/);
  assert.equal(f.forks(), 1);
});
