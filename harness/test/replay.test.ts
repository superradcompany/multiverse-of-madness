import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
