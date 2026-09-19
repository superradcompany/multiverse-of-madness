import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
