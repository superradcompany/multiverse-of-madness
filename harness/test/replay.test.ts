import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStore } from '../src/node/replay-store.ts';

type BoardWorld = { id: string; label: string; parentId?: string; turn: number; board: number[] };
const layout = { position: (world: BoardWorld) => world.turn, framesPerSegment: 2 };
test('turn-based replay joins selected ancestry and survives reopen without a game tick rate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-replay-'));
  try {
    const replay = new ReplayStore(dir, layout); await replay.open();
    for (let turn=0;turn<4;turn++) await replay.record({id:'root',label:'root',turn,board:[turn]},Buffer.from(`board ${turn}`));
    for (let turn=2;turn<5;turn++) await replay.record({id:'child',label:'child',parentId:'root',turn,board:[turn,1]},Buffer.from(`child ${turn}`));
    await replay.retainPath('child');await replay.flush();
    const reopened = new ReplayStore(dir,layout);await reopened.open();
    const path=await reopened.path('child',4);
    assert.deepEqual(path.segments.flatMap(s=>s.ticks),[0,1,2,3,4]);
    assert.deepEqual(path.segments.map(s=>s.worldId),['root','child']);
    assert.equal(path.missingHistory,false);
    assert.deepEqual((await reopened.get('child',1)).world.board,[3,1]);
    assert.ok(reopened.list().worlds.every(w=>w.selected));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('invalid adapter cursors fail closed instead of publishing reordered footage', async () => {
  const dir=await mkdtemp(join(tmpdir(),'harness-replay-invalid-'));
  try {
    const replay=new ReplayStore(dir,layout);await replay.open();
    await replay.record({id:'a',label:'a',turn:2,board:[]},Buffer.alloc(0));await replay.flush();
    await replay.record({id:'a',label:'a',turn:1,board:[]},Buffer.alloc(0));
    assert.match(replay.error!,/backwards/);
    assert.equal(replay.list().worlds[0]!.frames,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('retaining a winner publishes its buffered tail and protects every ancestor before collection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-selected-tail-'));
  const buffered = { ...layout, framesPerSegment: 35 }, retention = { maxAgeMs: 0, maxWorlds: 0 };
  try {
    const replay = new ReplayStore(dir, buffered, 1, retention); await replay.open();
    replay.protect(['root']);
    for (let turn = 0; turn <= 2; turn++) await replay.record({ id: 'root', label: 'root', turn, board: [turn] }, Buffer.from(`root ${turn}`));
    await replay.flush();
    // The parent is committed but unselected. Child retention must mark the
    // whole path before its flush invokes age/count/byte collection.
    replay.protect([]);
    for (let turn = 2; turn <= 4; turn++) await replay.record({ id: 'child', parentId: 'root', label: 'child', turn, board: [turn] }, Buffer.from(`child ${turn}`));
    await replay.retainPath('child');
    const reopened = new ReplayStore(dir, buffered, 1, retention); await reopened.open(); await reopened.collect();
    const path = await reopened.path('child');
    assert.equal(path.missingHistory, false);
    assert.deepEqual(path.segments.flatMap(segment => segment.ticks), [0, 1, 2, 3, 4]);
    assert.equal(Buffer.from((await reopened.get('child', 2)).frame, 'base64').toString(), 'child 4');
    assert.ok(reopened.list().worlds.every(world => world.selected));

    await replay.record({ id: 'child', parentId: 'root', label: 'child', turn: 5, board: [5] }, Buffer.from('child 5'));
    await replay.retainPath('child'); // Checkpointing an already selected world must flush its new tail too.
    const checkpoint = new ReplayStore(dir, buffered, 1, retention); await checkpoint.open();
    assert.equal((await checkpoint.get('child', 3)).world.turn, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed selected-tail publication rejects retention and can retry without losing committed frames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-selected-tail-failure-'));
  try {
    const replay = new ReplayStore(dir, { ...layout, framesPerSegment: 35 }); await replay.open();
    await replay.record({ id: 'root', label: 'root', turn: 0, board: [0] }, Buffer.from('zero'));
    await replay.retainPath('root');
    const block = join(dir, createHash('sha256').update('root').digest('hex'), '1.json.gz.tmp');
    await mkdir(block);
    await replay.record({ id: 'root', label: 'root', turn: 1, board: [1] }, Buffer.from('one'));
    await assert.rejects(replay.retainPath('root'));
    assert.equal(Buffer.from((await replay.get('root', 0)).frame, 'base64').toString(), 'zero');
    await rm(block, { recursive: true });
    await replay.retainPath('root');
    const reopened = new ReplayStore(dir, layout); await reopened.open();
    assert.deepEqual((await reopened.path('root')).segments.flatMap(segment => segment.ticks), [0, 1]);
    assert.equal(Buffer.from((await reopened.get('root', 1)).frame, 'base64').toString(), 'one');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed cleanup publication preserves footage and buffered selected frames until retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-replay-gc-publication-'));
  try {
    const replay = new ReplayStore(dir, layout, 1024 ** 2, { maxAgeMs: 0, maxWorlds: 0 });
    await replay.open(); replay.protect(['discarded', 'winner']);
    for (const id of ['discarded', 'winner']) {
      await replay.record({ id, label: id, turn: 0, board: [0] }, Buffer.from(id));
    }
    await replay.flush(); await replay.retainPath('winner');
    await replay.record({ id: 'winner', label: 'winner', turn: 1, board: [1] }, Buffer.from('pending winner'));
    const directory = join(dir, createHash('sha256').update('discarded').digest('hex'));
    const before = await readFile(join(directory, 'index.json'), 'utf8');
    await mkdir(join(directory, 'index.json.tmp'));
    replay.protect(['winner']); await replay.collect();
    assert.equal(replay.error, undefined);
    assert.match(replay.list().cleanupError!, /cleanup deferred/);
    assert.equal(await readFile(join(directory, 'index.json'), 'utf8'), before);
    assert.equal((await replay.get('discarded', 0)).world.turn, 0);
    assert.equal((await replay.get('winner', 1)).world.turn, 1);
    // A failed maintenance task must not stop subsequent selected recording.
    await replay.record({ id: 'winner', label: 'winner', turn: 2, board: [2] }, Buffer.from('next winner'));
    await replay.retainPath('winner');
    assert.equal(replay.error, undefined);
    await rm(join(directory, 'index.json.tmp'), { recursive: true });
    await replay.collect();
    assert.equal(replay.list().cleanupError, undefined);
    await assert.rejects(replay.get('discarded', 0), /not found/);
    const reopened = new ReplayStore(dir, layout); await reopened.open();
    assert.deepEqual((await reopened.path('winner')).segments.flatMap(segment => segment.ticks), [0, 1, 2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const mode of ['world', 'segment'] as const) {
  test(`${mode} cleanup retries failed deletion without resurrecting frames or losing byte accounting`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-replay-gc-delete-'));
    try {
      const initial = new ReplayStore(dir, layout); await initial.open();
      for (let turn = 0; turn < 4; turn++) await initial.record({ id: 'discarded', label: 'discarded', turn, board: [turn] }, Buffer.from(`frame ${turn}`));
      await initial.record({ id: 'winner', label: 'winner', turn: 0, board: [0] }, Buffer.from('winner'));
      await initial.retainPath('winner');
      const before = initial.list();
      const limit = mode === 'segment' ? before.bytes - before.retainedBytes - 1 : 1024 ** 2;
      const retention = mode === 'world' ? { maxAgeMs: 0, maxWorlds: 0 } : { maxAgeMs: 3600000, maxWorlds: 200 };
      const replay = new ReplayStore(dir, layout, limit, retention); await replay.open();
      const directory = join(dir, createHash('sha256').update('discarded').digest('hex'));
      // Fail the second removal for whole-world GC, exercising partial cleanup.
      const segment = join(directory, mode === 'world' ? '1.json.gz' : '0.json.gz');
      await rename(segment, `${segment}.saved`); await mkdir(segment);
      await replay.collect();
      assert.equal(replay.error, undefined);
      assert.match(replay.list().cleanupError!, /cleanup deferred/);
      await assert.rejects(replay.get('discarded', 0), /not found/);
      assert.equal(replay.list().retainedBytes, before.retainedBytes);
      const deferred = replay.list();
      await replay.collect();
      assert.equal(replay.list().bytes, deferred.bytes, 'retry must not double-subtract removed files');
      assert.equal(replay.list().collectedSegments, deferred.collectedSegments);
      await replay.record({ id: 'winner', label: 'winner', turn: 1, board: [1] }, Buffer.from('winner next'));
      await replay.retainPath('winner');
      assert.equal(replay.error, undefined);
      await rm(segment, { recursive: true }); await rename(`${segment}.saved`, segment);
      await replay.collect();
      assert.equal(replay.list().cleanupError, undefined);
      assert.equal(replay.list().collectedSegments, mode === 'world' ? 2 : 1);
      const reopened = new ReplayStore(dir, layout); await reopened.open();
      assert.equal(replay.list().bytes, reopened.list().bytes);
      assert.deepEqual((await reopened.path('winner')).segments.flatMap(segment => segment.ticks), [0, 1]);
      if (mode === 'segment') {
        assert.equal((await replay.get('discarded', 2)).world.turn, 2);
        assert.deepEqual((await readdir(directory)).sort(), ['1.json.gz', 'index.json']);
      } else assert.deepEqual(reopened.list().worlds.map(world => world.id), ['winner']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const recovery of ['reopen', 'reset'] as const) {
  test(`${recovery} reclaims unreferenced cleanup files while preserving the selected recording`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-replay-gc-recovery-'));
    try {
      const replay = new ReplayStore(dir, layout, 1024 ** 2, { maxAgeMs: 0, maxWorlds: 0 });
      await replay.open(); replay.protect(['discarded', 'winner']);
      for (const id of ['discarded', 'winner']) {
        await replay.record({ id, label: id, turn: 0, board: [0] }, Buffer.from(id));
      }
      await replay.flush(); await replay.retainPath('winner');
      const directory = join(dir, createHash('sha256').update('discarded').digest('hex'));
      const segment = join(directory, '0.json.gz');
      await rename(segment, `${segment}.saved`); await mkdir(segment);
      replay.protect(['winner']); await replay.collect();
      assert.ok(replay.list().cleanupError);
      await rm(segment, { recursive: true }); await rename(`${segment}.saved`, segment);
      // Recover without a successful collect on the original instance.
      const recovered = recovery === 'reopen' ? new ReplayStore(dir, layout) : replay;
      if (recovery === 'reopen') await recovered.open();
      else await recovered.clearExcept('winner');
      await recovered.collect();
      assert.equal(recovered.list().cleanupError, undefined);
      assert.equal(recovered.list().bytes, recovered.list().retainedBytes);
      assert.equal((await recovered.get('winner', 0)).world.turn, 0);
      await assert.rejects(recovered.get('discarded', 0), /not found/);
      if (recovery === 'reopen') assert.deepEqual(await readdir(directory), ['index.json']);
      const verification = new ReplayStore(dir, layout); await verification.open();
      assert.equal(verification.list().bytes, recovered.list().bytes);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
