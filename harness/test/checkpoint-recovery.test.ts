import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointRecovery, type CheckpointJournal, type CheckpointRecord } from '../src/checkpoint-recovery.ts';
import { WorldLifecycle, type WorldMetadata } from '../src/world-lifecycle.ts';

type Board = { turn: number; score: number };
class Runtime {
  readonly identity: string;
  removed = false;
  constructor(readonly id: string, readonly board: Board) { this.identity = `physical:${id}`; }
  async destroy() { this.removed = true; }
}
type World = { meta: WorldMetadata; runtime?: Runtime; trail: number[] };
type Point = CheckpointRecord & { board: Board; trail: number[] };
function setup(beforePublication?: () => Promise<void>, limit: number | (() => number) = 2) {
  const journal: CheckpointJournal<Point> = { points: [], cleanup: [] };
  const snapshots = new Map<string, Board>();
  const saved: Array<{ mainId: string; journal: CheckpointJournal<Point> }> = [];
  let sequence = 0, restored = 0;
  const faults = { publication: false, capture: false, attach: false, removal: false, checkpointPublication: false };
  const persist = async () => {
    if (faults.checkpointPublication && !journal.pendingCapture && !journal.pendingRestore) throw new Error('checkpoint publication failed');
    if (lifecycle.mainId !== 'root') await beforePublication?.();
    if (faults.publication && lifecycle.mainId !== 'root') throw new Error('publication failed');
    saved.push({ mainId: lifecycle.mainId, journal: structuredClone(journal) });
  };
  const lifecycle = new WorldLifecycle<World, Runtime>({ metadata: world => world.meta, persist });
  const root = new Runtime('root', { turn: 0, score: 0 });
  lifecycle.register({ meta: { id: root.id, role: 'main', status: 'paused', controller: 'ai' }, runtime: root, trail: [] });
  lifecycle.mainId = root.id;
  const recovery = new CheckpointRecovery<Point, World, Runtime>(lifecycle, {
    journal: () => journal,
    adapter: () => ({
      capture: async (runtime, reference) => {
        assert.equal(saved.at(-1)!.journal.pendingCapture, reference);
        snapshots.set(reference, structuredClone(runtime.board));
        if (faults.capture) throw new Error('capture acknowledgement lost');
      },
      restore: async (reference, id) => {
        assert.equal(saved.at(-1)!.journal.pendingRestore?.id, id);
        return new Runtime(id, structuredClone(snapshots.get(reference)!));
      },
      remove: async reference => {
        if (faults.removal) { faults.removal = false; throw new Error('storage unavailable'); }
        snapshots.delete(reference);
      },
    }),
    point: world => ({ id: `point-${++sequence}`, reference: `artifact-${sequence}`, createdAt: sequence, board: structuredClone(world.runtime!.board), trail: structuredClone(world.trail) }),
    attach: async (runtime, point) => {
      if (faults.attach) throw new Error('checkpoint state mismatch');
      assert.deepEqual(runtime.board, point.board);
      return { meta: { id: runtime.id, role: 'experiment', status: 'paused', controller: 'ai' }, runtime, trail: [...point.trail] };
    },
    stageRestore: () => { restored++; return () => { restored--; }; },
    restoreId: () => `restored-${sequence}`,
    persist, limit,
  });
  return { lifecycle, recovery, root, journal, snapshots, saved, faults, restored: () => restored };
}

test('capture and restore preserve adapter data, prune abandoned checkpoints and keep the old run until publication', async () => {
  const { lifecycle, recovery, root, journal, snapshots, saved, restored } = setup();
  const first = await recovery.capture();
  root.board.turn = 3; root.board.score = 7; lifecycle.world('root').trail.push(3);
  await recovery.capture();
  assert.deepEqual(first.board, { turn: 0, score: 0 });
  const oldDestroy = root.destroy.bind(root);
  root.destroy = async () => {
    assert.notEqual(saved.at(-1)!.mainId, root.id);
    assert.equal(saved.at(-1)!.journal.pendingRestore, undefined);
    await oldDestroy();
  };
  await recovery.restore(first.id);
  const winner = lifecycle.world(lifecycle.mainId);
  assert.deepEqual(winner.runtime!.board, first.board);
  assert.deepEqual(winner.trail, []);
  assert.equal(root.removed, true);
  assert.equal(restored(), 1);
  assert.deepEqual(journal.points.map(point => point.id), [first.id]);
  assert.deepEqual([...snapshots.keys()], [first.reference]);
});
test('retention deletes only evicted artifacts and failed capture remains reconcilable', async () => {
  const { recovery, journal, snapshots, faults } = setup();
  await recovery.capture(); await recovery.capture(); await recovery.capture();
  assert.equal(journal.points.length, 2); assert.equal(snapshots.size, 2);
  faults.capture = true;
  await assert.rejects(recovery.capture(), /acknowledgement lost/);
  assert.equal(journal.pendingCapture, 'artifact-4');
  await assert.rejects(recovery.capture(), /Reconcile/);
  recovery.reconcileCapture();
  await recovery.collect();
  assert.equal(journal.pendingCapture, undefined);
  assert.equal(snapshots.has('artifact-4'), false);
  assert.equal(journal.points.length, 2);
});
test('invalid restored state leaves the source and pending runtime identity available for recovery', async () => {
  const { recovery, lifecycle, journal, faults, root } = setup();
  const point = await recovery.capture();
  faults.attach = true;
  await assert.rejects(recovery.restore(point.id), /state mismatch/);
  assert.equal(lifecycle.mainId, 'root'); assert.equal(root.removed, false);
  assert.deepEqual(journal.pendingRestore, { id: 'restored-1', pointId: point.id });
  faults.attach = false;
  await recovery.recover(new Runtime('restored-1', structuredClone(point.board)), point.id);
  assert.equal(lifecycle.mainId, 'restored-1'); assert.equal(journal.pendingRestore, undefined);
});
test('failed restore publication rolls back checkpoint pruning and staged learning counters', async () => {
  const { recovery, lifecycle, journal, faults, restored, root } = setup();
  const first = await recovery.capture(); await recovery.capture();
  faults.publication = true;
  await assert.rejects(recovery.restore(first.id), /publication failed/);
  assert.equal(lifecycle.mainId, 'root'); assert.equal(root.removed, false);
  assert.equal(restored(), 0);
  assert.equal(journal.points.length, 2);
  assert.equal(journal.pendingRestore?.pointId, first.id);
  assert.deepEqual(journal.cleanup, []);
  faults.publication = false;
  const pending = lifecycle.world(journal.pendingRestore!.id).runtime!;
  await recovery.recover(pending, first.id);
  assert.equal(lifecycle.mainId, pending.id);
  assert.equal(restored(), 1); assert.equal(journal.points.length, 1);
});
test('queued collectors serialize and a rejected collector does not poison future retries', async () => {
  const { recovery, journal, snapshots, faults } = setup();
  await recovery.capture();
  faults.removal = true;
  journal.cleanup.push('already-missing');
  const results = await Promise.allSettled([recovery.collect(), recovery.collect(), recovery.collect()]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(journal.cleanup, []); assert.equal(snapshots.size, 1);
});

test('checkpoint GC cannot delete a retained execution checkpoint', async () => {
  const { recovery, journal, snapshots } = setup();
  const point = await recovery.capture();
  journal.cleanup.push(point.reference);
  await assert.rejects(recovery.collect(), /retained checkpoint/);
  assert.equal(snapshots.has(point.reference), true);
});

test('GC waits for restore publication and cannot collect checkpoints from a rolled-back transaction', async () => {
  let entered!: () => void, finish!: () => void;
  const publishing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const { recovery, journal, snapshots } = setup(async () => { entered(); await blocked; throw new Error('publication unavailable'); });
  const first = await recovery.capture(); await recovery.capture();
  const failed = assert.rejects(recovery.restore(first.id), /publication unavailable/);
  await publishing;
  const collected = recovery.collect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.size, 2);
  finish(); await failed; await collected;
  assert.equal(journal.points.length, 2);
  assert.equal(snapshots.size, 2);
});

test('failed checkpoint deletion publication keeps the checkpoint out of the GC queue', async () => {
  const { recovery, journal, snapshots, faults } = setup();
  const point = await recovery.capture();
  faults.checkpointPublication = true;
  await assert.rejects(recovery.remove(point.id), /checkpoint publication failed/);
  assert.deepEqual(journal.points.map(entry => entry.id), [point.id]);
  assert.deepEqual(journal.cleanup, []);
  await recovery.collect();
  assert.equal(snapshots.has(point.reference), true);
});
test('capture publication failure preserves its pending intent and restores the retained checkpoint list', async () => {
  const { recovery, journal, snapshots, faults } = setup();
  const first = await recovery.capture();
  faults.checkpointPublication = true;
  await assert.rejects(recovery.capture(), /checkpoint publication failed/);
  assert.deepEqual(journal.points.map(entry => entry.id), [first.id]);
  assert.equal(journal.pendingCapture, 'artifact-2');
  assert.equal(snapshots.has('artifact-2'), true);
  faults.checkpointPublication = false;
  recovery.reconcileCapture(); await recovery.collect();
  assert.equal(snapshots.has('artifact-2'), false);
  assert.equal(snapshots.has(first.reference), true);
});

test('revision retention limits are validated and captured before asynchronous checkpoint dispatch', async () => {
  let limit = 2;
  const { recovery, journal, snapshots } = setup(undefined, () => { const captured = limit; queueMicrotask(() => { limit = 1; }); return captured; });
  await recovery.capture();
  limit = 2; await recovery.capture();
  assert.equal(journal.points.length, 2); // The in-flight capture kept its original limit.
  await recovery.capture(); assert.equal(journal.points.length, 1); assert.equal(snapshots.size, 1);
  limit = 0;
  await assert.rejects(recovery.capture(), /Invalid checkpoint retention limit/);
  assert.equal(journal.pendingCapture, undefined); assert.equal(snapshots.size, 1);
});
