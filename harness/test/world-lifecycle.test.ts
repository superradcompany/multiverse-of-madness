import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldLifecycle, type WorldMetadata, type RuntimeReference } from '../src/world-lifecycle.ts';
import { runTrials } from '../src/trials.ts';

type Board = { turn: number; cells: number[]; points: number };
class BoardRuntime {
  readonly identity: string;
  removed = false;
  constructor(readonly id: string, readonly board: Board = { turn: 0, cells: [1, 2, 3], points: 0 }) { this.identity = `engine:${id}`; }
  fork(id: string) { return new BoardRuntime(id, structuredClone(this.board)); }
  async move(direction: number) { this.board.turn++; this.board.cells.push(direction); this.board.points += direction; }
  async destroy() { this.removed = true; }
}
type World = { meta: WorldMetadata; runtime?: BoardRuntime; notes: string[] };
const world = (runtime: BoardRuntime, role: WorldMetadata['role']): World => ({ meta: { id: runtime.id, role, status: 'paused', controller: 'ai' }, runtime, notes: [] });
function fixture(persist?: () => Promise<void>) {
  const main = new BoardRuntime('root'), left = main.fork('left'), right = main.fork('right');
  const snapshots: Array<{ mainId: string; roles: string[]; cleanup: RuntimeReference[] }> = [];
  let staged = false;
  const lifecycle = new WorldLifecycle<World, BoardRuntime>({
    metadata: w => w.meta,
    stageSelection: () => { staged = true; return () => { staged = false; }; },
    persist: async () => {
      await persist?.();
      snapshots.push({ mainId: lifecycle.mainId, roles: [...lifecycle.worlds.values()].map(w => w.meta.role), cleanup: structuredClone(lifecycle.cleanup) });
    },
  });
  lifecycle.register(world(main, 'main')); lifecycle.register(world(left, 'experiment')); lifecycle.register(world(right, 'experiment'));
  lifecycle.mainId = main.id;
  return { lifecycle, main, left, right, snapshots, staged: () => staged };
}

test('turn-based forks use the shared runner and promote an entire divergent world after durable publication', async () => {
  const { lifecycle, main, left, right, snapshots } = fixture();
  await runTrials([left, right].map((runtime, i) => ({
    id: runtime.id, baseline: { sequence: 0, elapsed: 0, unit: 'turns' as const }, duration: { amount: 3, unit: 'turns' as const },
    clock: () => ({ sequence: runtime.board.turn, elapsed: runtime.board.turn, unit: 'turns' as const }),
    terminal: () => false,
    advance: () => runtime.move(i === 0 ? 1 : -1),
  })), new AbortController().signal);
  assert.deepEqual(main.board, { turn: 0, cells: [1, 2, 3], points: 0 });
  assert.notDeepEqual(left.board, right.board);
  const originalDestroy = main.destroy.bind(main);
  main.destroy = async () => {
    assert.equal(snapshots.at(-1)!.mainId, left.id);
    assert.deepEqual(snapshots.at(-1)!.roles, ['archived', 'main', 'archived']);
    assert.ok(snapshots.at(-1)!.cleanup.some(ref => ref.identity === main.identity));
    await originalDestroy();
  };
  await lifecycle.promote(left.id);
  assert.equal(lifecycle.mainId, left.id);
  assert.equal(lifecycle.world(left.id).runtime, left);
  await left.move(1);
  assert.equal(left.board.turn, 4);
  assert.equal(left.board.points, 4);
  assert.equal(main.removed, true); assert.equal(right.removed, true); assert.equal(left.removed, false);
  assert.deepEqual(lifecycle.cleanup, []);
});
test('failed publication restores roles, runtimes, cleanup and staged metadata without destroying a world', async () => {
  const failure = new Error('disk unavailable');
  const { lifecycle, main, left, right, staged } = fixture(async () => { throw failure; });
  await assert.rejects(lifecycle.promote(left.id), error => error === failure);
  assert.equal(lifecycle.mainId, main.id);
  assert.deepEqual([...lifecycle.worlds.values()].map(w => w.meta.role), ['main', 'experiment', 'experiment']);
  assert.deepEqual([...lifecycle.worlds.values()].map(w => w.runtime), [main, left, right]);
  assert.deepEqual(lifecycle.cleanup, []);
  assert.equal(staged(), false);
  assert.ok([main, left, right].every(runtime => !runtime.removed));
});
test('partial release retains the durable winner and retries only journaled failures', async () => {
  const { lifecycle, main, left, right, snapshots } = fixture();
  main.destroy = async () => { throw new Error('temporarily unavailable'); };
  await assert.rejects(lifecycle.promote(left.id), /temporarily unavailable/);
  assert.equal(lifecycle.mainId, left.id); assert.equal(right.removed, true);
  assert.deepEqual(snapshots.at(-1)!.cleanup, [{ id: main.id, identity: main.identity }]);
  const deleted: RuntimeReference[] = [];
  await lifecycle.collect(async (id, identity) => { deleted.push({ id, identity }); });
  assert.deepEqual(deleted, [{ id: main.id, identity: main.identity }]);
  assert.equal(lifecycle.cleanup.length, 0);
  lifecycle.cleanup.push({ id: left.id, identity: left.identity });
  await assert.rejects(lifecycle.collect(async () => assert.fail('active runtime must remain')), /active runtime/);
});
test('lifecycle transitions are exclusive and pause joins publication before handing over control', async () => {
  let entered!: () => void, finish!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const { lifecycle, left } = fixture(async () => { entered(); await release; });
  const selection = lifecycle.promote(left.id);
  await saving;
  assert.equal(lifecycle.busy, true);
  assert.throws(() => lifecycle.promote('right'), /already in progress/);
  assert.throws(() => lifecycle.replace(new Map()), /in progress/);
  let joined = false;
  const pause = lifecycle.join().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false);
  finish(); await selection; await pause;
  assert.equal(joined, true); assert.equal(lifecycle.busy, false);
});
test('cancelled selection leaves the source intact and duplicate runtime identities are refused', async () => {
  const { lifecycle, main, left } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lifecycle.promote(left.id, { signal: controller.signal }), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(lifecycle.mainId, main.id); assert.equal(main.removed, false);
  assert.throws(() => lifecycle.register(world(main, 'main')), /already registered/);
  const alias = Object.assign(new BoardRuntime('alias'), { identity: main.identity });
  assert.throws(() => lifecycle.register(world(alias, 'experiment')), /already owned/);
  assert.throws(() => lifecycle.replace(new Map([['different-name', world(main, 'main')]])), /identity mismatch/);
  assert.equal(lifecycle.worlds.size, 3);
});


test('background retirement publishes first and lets the winner advance while pause joins all deletions', async () => {
  const { lifecycle, main, left, right, snapshots } = fixture();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  main.destroy = async () => { await blocked; main.removed = true; };
  await lifecycle.promote(left.id, { cleanup: 'background' });
  assert.equal(lifecycle.mainId, left.id);
  assert.equal(main.removed, false);
  assert.equal(snapshots.at(-1)!.cleanup.length, 2);
  await left.move(1);
  assert.equal(left.board.turn, 1, 'gameplay does not wait for loser deletion');
  assert.throws(() => lifecycle.register(world(new BoardRuntime('extra'), 'experiment')), /in progress/);
  let joined = false;
  const pause = lifecycle.join().then(() => { joined = true; });
  const shutdown = lifecycle.join();
  await Promise.resolve(); assert.equal(joined, false);
  finish(); await Promise.all([pause, shutdown]);
  assert.equal(main.removed, true); assert.equal(right.removed, true);
  assert.equal(left.removed, false); assert.equal(lifecycle.busy, false);
  assert.deepEqual(snapshots.at(-1)!.cleanup, []);
});

test('background deletion failures remain journaled and are reported at the ownership boundary', async () => {
  const { lifecycle, main, left, right } = fixture();
  main.destroy = async () => { throw new Error('delete failed'); };
  await lifecycle.promote(left.id, { cleanup: 'background' });
  await left.move(1);
  await assert.rejects(lifecycle.join(), /delete failed/);
  assert.deepEqual(lifecycle.cleanup, [{ id: main.id, identity: main.identity }]);
  assert.equal(right.removed, true); assert.equal(left.removed, false);
  const retries: RuntimeReference[] = [];
  await lifecycle.collect(async (id, identity) => { retries.push({ id, identity }); });
  assert.deepEqual(retries, [{ id: main.id, identity: main.identity }]);
  assert.deepEqual(lifecycle.cleanup, []);
});

test('failed background journal settlement can be retried without dispatching deletion again', async () => {
  let fail = false, deletes = 0;
  const { lifecycle, main, left } = fixture(async () => { if (fail) throw new Error('journal unavailable'); });
  main.destroy = async () => { deletes++; };
  await lifecycle.promote(left.id, { cleanup: 'background' });
  fail = true;
  await assert.rejects(lifecycle.join(), /journal unavailable/);
  assert.equal(lifecycle.busy, true);
  fail = false;
  await lifecycle.join();
  assert.equal(deletes, 1); assert.equal(lifecycle.busy, false);
});
