import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, BudgetExhausted } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomEvaluationVms, decodeDoomEvaluationVms, doomIncidentCheckpoint, type DoomEvaluationVmPorts, type SavedDoomEvaluationVms } from './doom-evaluation-vms.ts';
import type { GameState, Step } from '../../../packages/contracts/src/game.ts';
import type { WorldRuntime } from './runtime.ts';
import { initial } from '../test-support/fixture-runtime.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const reference = () => `mom-checkpoint-${randomUUID()}:recovery`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doom-evaluation-vms-'));
  const worlds = new Map<string, FakeVm>();
  const points = new Map<string, { identity: string; game: GameState; owner: string; run: string }>();
  const hooks: { persist?: (value: SavedDoomEvaluationVms) => Promise<void>; create?: () => Promise<void>; fork?: () => Promise<void>;
    destroy?: () => Promise<void>; restore?: () => Promise<void>; capture?: () => Promise<void>; retainPoints?: boolean } = {};
  class FakeVm implements WorldRuntime {
    identity = randomUUID();
    parent?: string;
    constructor(readonly id: string, readonly owner: string, readonly run: string, private game = structuredClone(initial)) { worlds.set(id, this); }
    async state() { return structuredClone(this.game); }
    async frame() { return Buffer.alloc(0); }
    async step(command: Step) { this.game.tick += command.ticks; this.game.x += command.ticks; return this.state(); }
    async branch(ids: string[]) {
      const children = ids.map(id => { const child = new FakeVm(id, this.owner, this.run, structuredClone(this.game)); child.parent = this.parent; return child; });
      await hooks.fork?.(); return children;
    }
    async destroy() { await ports.destroy(this.id, this.identity, this.owner, this.run); }
  }
  const ports: DoomEvaluationVmPorts = {
    create: async (id, owner, run) => { const world = new FakeVm(id, owner, run); await hooks.create?.(); return world; },
    destroy: async (id, identity, owner, run, restoredFrom) => {
      const world = worlds.get(id); if (!world) return;
      if (identity && identity !== world.identity) throw new Error('VM was replaced');
      if ((world.owner !== owner || world.run !== run) && (!restoredFrom || world.parent !== restoredFrom)) throw new Error('Ownership labels differ');
      await hooks.destroy?.(); worlds.delete(id);
    },
    capture: async (world, ref) => {
        const source = worlds.get(world.id)!;
        points.set(ref, { identity: randomUUID(), game: await world.state(), owner: source.owner, run: source.run }); await hooks.capture?.();
      },
    restore: async (ref, id) => { const point = points.get(ref)!; const world = new FakeVm(id, point.owner, point.run, structuredClone(point.game)); world.parent = point.identity; await hooks.restore?.(); return world; },
    parentSnapshot: async world => worlds.get(world.id)?.parent,
    snapshotIdentity: async ref => points.get(ref)?.identity,
    collect: async requested => {
      for (const point of requested) if (point.identity && points.has(point.reference) && point.identity !== points.get(point.reference)!.identity) throw new Error('Snapshot was replaced');
      if (hooks.retainPoints) return requested.map(point => point.reference);
      for (const point of requested) points.delete(point.reference); return [];
    },
  };
  const disk = new JsonFileStore(join(root, 'resources.json'), decodeDoomEvaluationVms);
  const store = { load: () => disk.load(), save: async (value: SavedDoomEvaluationVms) => { await disk.save(value); await hooks.persist?.(value); }, flush: () => disk.flush() };
  let owner = await DoomEvaluationVms.open(store, ports);
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 100, modelCalls: 0 } });
  const control = new AbortController();
  return { root, disk, worlds, points, hooks, ledger, control, get owner() { return owner; },
    reopen: async () => { owner = await DoomEvaluationVms.open(store, ports); },
    cleanup: async () => { hooks.persist = undefined; hooks.destroy = undefined; hooks.retainPoints = false; await owner.recover().catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test('VM initialization and every child input are metered, exact fork/restore consume no replay ticks, all resources are collected', async () => {
  const f = await fixture();
  try {
    const world = await f.owner.create('run-a', f.ledger, f.control.signal, [{ ticks: 7, inputs: ['left'] }]);
    assert.equal(f.ledger.used('simulation'), 42);
    const before = await world.state(), [left, right] = await world.branch(['child-left', 'child-right']);
    assert.deepEqual(await left!.state(), before); assert.deepEqual(await right!.state(), before); assert.equal(f.ledger.used('simulation'), 42);
    await Promise.all([left!.step({ ticks: 7, inputs: ['forward'] }), right!.step({ ticks: 7, inputs: ['backward'] })]);
    assert.equal(f.ledger.used('simulation'), 56);
    const adapter = f.owner.checkpoints('run-a'), ref = reference(); await adapter.capture(left!, ref);
    const restored = await adapter.restore(ref, 'restored'); assert.deepEqual(await restored.state(), await left!.state());
    assert.equal(f.owner.snapshot().runs[0]!.worlds.find(world => world.id === 'restored')!.restoredFrom, f.points.get(ref)!.identity);
    await restored.branch(['restored-child']);
    assert.equal(f.owner.snapshot().runs[0]!.worlds.find(world => world.id === 'restored-child')!.restoredFrom, f.points.get(ref)!.identity);
    assert.equal(f.ledger.used('simulation'), 56); await restored.step({ ticks: 7, inputs: [] }); assert.equal(f.ledger.used('simulation'), 63);
    assert.deepEqual(await adapter.collect!([ref]), [ref], 'the Session checkpoint adapter reports deleted references');
    await f.owner.cleanup('run-a'); assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 0);
    assert.ok(f.owner.snapshot().runs[0]!.worlds.every(world => world.released)); assert.equal(f.ledger.pending, 0);
    await assert.rejects(f.owner.create('run-a', f.ledger, f.control.signal), /never repeat/);
    await f.reopen(); assert.equal(f.worlds.size, 0);
  } finally { await f.cleanup(); }
});

test('resource intents precede provider dispatch; partial fork and restore failures are recovered without replay', async () => {
  for (const operation of ['create', 'fork', 'restore', 'capture'] as const) {
    const f = await fixture();
    try {
      const failure = async () => { throw new Error('Provider lost acknowledgment'); };
      if (operation === 'create') { f.hooks.create = failure; await assert.rejects(f.owner.create('run', f.ledger, f.control.signal), /lost acknowledgment/); }
      else {
        const world = await f.owner.create('run', f.ledger, f.control.signal);
        const adapter = f.owner.checkpoints('run'), ref = reference();
        if (operation === 'fork') { f.hooks.fork = failure; await assert.rejects(world.branch(['child-a', 'child-b']), /lost acknowledgment/); }
        else if (operation === 'capture') { f.hooks.capture = failure; await assert.rejects(adapter.capture(world, ref), /lost acknowledgment/); }
        else { await adapter.capture(world, ref); f.hooks.restore = failure; await assert.rejects(adapter.restore(ref, 'restored'), /lost acknowledgment/); }
      }
      assert.ok(f.worlds.size > 0); await f.reopen();
      assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 0); assert.ok(f.owner.snapshot().runs[0]!.closed);
    } finally { await f.cleanup(); }
  }
});

test('cancelled creation is joined before cleanup and never loses its late-created VM', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.hooks.create = async () => { entered.resolve(); await release.promise; };
    const creating = f.owner.create('run', f.ledger, f.control.signal); await entered.promise;
    f.control.abort(new Error('Stop evaluation')); let cleaned = false;
    const cleanup = f.owner.cleanup('run').then(() => { cleaned = true; });
    await Promise.resolve(); assert.equal(cleaned, false);
    release.resolve(); await assert.rejects(creating, /Stop evaluation/); await cleanup;
    assert.equal(f.worlds.size, 0); assert.equal(f.ledger.used('simulation'), 35); assert.equal(f.ledger.pending, 0);
  } finally { release.resolve(); await f.cleanup(); }
});

test('a persistence failure prevents dispatch and a failed creation acknowledgment is cleaned on reopen', async () => {
  for (const afterIdentity of [false, true]) {
    const f = await fixture();
    try {
      f.hooks.persist = async saved => { if (saved.runs[0] && Boolean(saved.runs[0].worlds[0]?.identity) === afterIdentity) throw new Error('Resource journal failed'); };
      await assert.rejects(f.owner.create('run', f.ledger, f.control.signal), /Resource journal failed/);
      assert.equal(f.worlds.size, Number(afterIdentity));
      await assert.rejects(f.owner.create('another', f.ledger, f.control.signal), /publication failed/);
      f.hooks.persist = undefined; await f.reopen(); assert.equal(f.worlds.size, 0);
    } finally { await f.cleanup(); }
  }
});

test('replaced VM and checkpoint identities refuse cleanup, retain pending ownership and block the next run', async () => {
  for (const kind of ['world', 'point']) {
    const f = await fixture();
    try {
      const world = await f.owner.create('run', f.ledger, f.control.signal), ref = reference();
      await f.owner.checkpoints('run').capture(world, ref);
      const resource = kind === 'world' ? f.worlds.get(world.id)! : f.points.get(ref)!;
      const identity = resource.identity; resource.identity = randomUUID();
      await assert.rejects(f.owner.cleanup('run'), /cleanup is incomplete/);
      await assert.rejects(f.owner.create('next', f.ledger, f.control.signal), /previous evaluation/);
      assert.equal(kind === 'world' ? f.worlds.has(world.id) : f.points.has(ref), true);
      resource.identity = identity; await f.reopen(); assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 0);
    } finally { await f.cleanup(); }
  }
});

test('budget exhaustion dispatches no extra input and retained checkpoint dependencies remain pending', async () => {
  const f = await fixture();
  try {
    const world = await f.owner.create('run', f.ledger, f.control.signal);
    await world.step({ ticks: 35, inputs: [] }); const before = await world.state();
    await assert.rejects(world.step({ ticks: 35, inputs: [] }), BudgetExhausted); assert.deepEqual(await world.state(), before);
    const ref = reference(); await f.owner.checkpoints('run').capture(world, ref); f.hooks.retainPoints = true;
    await assert.rejects(f.owner.cleanup('run'), /cleanup is incomplete/); assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 1);
    assert.equal(f.owner.snapshot().runs[0]!.checkpoints[0]!.released, false);
    f.hooks.retainPoints = false; await f.reopen(); assert.equal(f.points.size, 0);
  } finally { await f.cleanup(); }
});

test('paired incident runs restore the same late-game state, meter only new inputs and retain the borrowed snapshot', async () => {
  const f = await fixture();
  try {
    const ref = reference(), game = { ...initial, tick: 45000, health: 42, x: 1024, y: 640, z: -128 };
    f.points.set(ref, { identity: 'incident-original', game, owner: 'live', run: 'live' });
    const incident = doomIncidentCheckpoint(ref, 'incident-original', game);
    for (const run of ['baseline', 'candidate']) {
      const before = f.ledger.used('simulation');
      const world = await f.owner.create(run, f.ledger, f.control.signal, [], incident);
      assert.deepEqual(await world.state(), game); assert.equal(f.ledger.used('simulation'), before);
      const [child] = await world.branch([`${run}-future`]);
      assert.deepEqual(await child!.state(), game);
      await child!.step({ ticks: 7, inputs: ['forward'] });
      assert.equal(f.ledger.used('simulation'), before + 7);
      await f.owner.cleanup(run);
      assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 1);
      assert.deepEqual(f.points.get(ref)!.game, game);
    }
    await f.reopen(); assert.equal(f.points.size, 1, 'recovery does not delete borrowed input');
  } finally { await f.cleanup(); }
});

test('incident validation rejects replaced snapshots and mismatched state, and recovers lost restore acknowledgements', async () => {
  for (const failure of ['identity', 'state', 'acknowledgement'] as const) {
    const f = await fixture();
    try {
      const ref = reference(); f.points.set(ref, { identity: 'original', game: initial, owner: 'live', run: 'live' });
      const incident = doomIncidentCheckpoint(ref, failure === 'identity' ? 'different' : 'original', failure === 'state' ? { ...initial, health: 1 } : initial);
      if (failure === 'acknowledgement') f.hooks.restore = async () => { throw new Error('Lost acknowledgement'); };
      await assert.rejects(f.owner.create('incident', f.ledger, f.control.signal, [], incident));
      await f.owner.recover();
      assert.equal(f.worlds.size, 0); assert.equal(f.points.size, 1); assert.equal(f.ledger.used('simulation'), 0);
    } finally { await f.cleanup(); }
  }
});
