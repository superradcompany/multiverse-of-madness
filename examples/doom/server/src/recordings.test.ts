import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recordings } from './recordings.ts';
import type { WorldView } from '../../contracts/src/session.ts';

test('recordings preserve matching states and frames across restart and reject invalid positions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-recording-'));
  try {
    const store = new Recordings(directory); await store.open();
    const world = { id: '../untrusted-name', label: 'turn left', state: { tick: 0, health: 100, kills: 3 } } as WorldView;
    for (let tick = 0; tick < 40; tick++) {
      world.state.tick = tick;
      await store.record(world, Buffer.from(`frame-${tick}`));
    }
    await store.record(world, Buffer.from('duplicate')); // same tick is not recorded again
    assert.equal(store.list().worlds[0]!.frames, 40);
    assert.equal((await store.get(world.id, 36)).world.state.tick, 36);
    await store.flush();
    const restored = new Recordings(directory); await restored.open();
    for (const index of [0, 34, 35, 39]) {
      const record = await restored.get(world.id, index);
      assert.equal(record.world.state.tick, index);
      assert.equal(record.world.state.kills, 3);
      assert.equal(Buffer.from(record.frame, 'base64').toString(), `frame-${index}`);
    }
    await assert.rejects(restored.get(world.id, -1), /not found/);
    await assert.rejects(restored.get(world.id, 40), /not found/);
    await assert.rejects(restored.get('missing', 0), /not found/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recording limit reports a stop and does not advertise uncommitted frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-limit-'));
  try {
    const store = new Recordings(directory, 1); await store.open();
    await store.record({ id: 'world', label: 'test', state: { tick: 1 } } as WorldView, Buffer.from('frame'));
    await store.flush();
    assert.match(store.error!, /limit reached/);
    assert.equal(store.list().worlds.length, 0);
    await assert.rejects(store.get('world', 0), /not found/);
    await store.record({ id: 'world', state: { tick: 2 } } as WorldView, Buffer.from('another'));
    assert.equal(store.list().worlds.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('byte retention rolls unprotected recordings forward with stable frame ids across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-rolling-'));
  const world = { id: 'active', label: 'test', state: { tick: 0, health: 100 } } as WorldView;
  try {
    const initial = new Recordings(directory); await initial.open();
    for (let tick = 0; tick < 35; tick++) { world.state.tick = tick; await initial.record(world, Buffer.from(`frame-${tick}`)); }
    const limit = initial.list().bytes + 100;
    const store = new Recordings(directory, limit); await store.open();
    for (let tick = 35; tick < 105; tick++) { world.state.tick = tick; await store.record(world, Buffer.from(`frame-${tick}`)); }
    assert.equal(store.error, undefined);
    assert.ok(store.list().bytes <= limit);
    assert.equal(store.list().worlds[0]!.firstFrame, 70);
    await assert.rejects(store.get('active', 0), /not found/);
    assert.equal((await store.get('active', 70)).world.state.tick, 70);
    assert.equal(Buffer.from((await store.get('active', 104)).frame, 'base64').toString(), 'frame-104');
    const restored = new Recordings(directory, limit); await restored.open();
    assert.equal(restored.list().worlds[0]!.firstFrame, 70);
    assert.equal((await restored.get('active', 104)).world.state.tick, 104);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('world retention removes old inactive footage while protecting active worlds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-retention-'));
  try {
    const store = new Recordings(directory, 1024 ** 2, { maxAgeMs: 3600000, maxWorlds: 2 });
    await store.open(); store.protect(['main']);
    for (const id of ['main', 'discarded-a', 'discarded-b']) {
      await store.record({ id, label: id, state: { tick: 1 } } as WorldView, Buffer.from(id)); await store.flush();
    }
    await store.collect();
    assert.deepEqual(store.list().worlds.map(w => w.id), ['main', 'discarded-b']);
    assert.equal((await store.get('main', 0)).world.id, 'main');
    await assert.rejects(store.get('discarded-a', 0), /not found/);
    const restored = new Recordings(directory); await restored.open();
    assert.equal(restored.list().worlds.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stitched replay follows ancestry at fork ticks without duplicates or discarded siblings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-path-'));
  try {
    const store = new Recordings(directory); await store.open();
    const record = async (id: string, parentId: string | undefined, from: number, to: number) => {
      for (let tick = from; tick <= to; tick++) await store.record({ id, parentId, label: id, state: { tick } } as WorldView, Buffer.from(`${id}-${tick}`));
    };
    await record('root', undefined, 0, 15);
    await record('winner', 'root', 10, 20);
    await record('loser', 'root', 10, 20);
    await record('next', 'winner', 20, 30);
    const path = await store.path('next', 25);
    assert.equal(path.missingHistory, false);
    assert.deepEqual(path.segments.map(s => s.worldId), ['root', 'winner', 'next']);
    assert.deepEqual(path.segments.flatMap(s => s.ticks), Array.from({ length: 26 }, (_, i) => i));
    for (const segment of path.segments) for (const [offset, tick] of segment.ticks.entries()) {
      const frame = await store.get(segment.worldId, segment.firstFrame + offset);
      assert.equal(frame.world.state.tick, tick);
      assert.equal(Buffer.from(frame.frame, 'base64').toString(), `${segment.worldId}-${tick}`);
    }
    await store.flush();
    const restored = new Recordings(directory); await restored.open();
    assert.deepEqual(await restored.path('next', 25), path);
    assert.deepEqual((await store.path('next', 25, true)).segments.flatMap(s => s.ticks), [20, 21, 22, 23, 24, 25]);
    await assert.rejects(store.path('next', -1), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('selected ancestry survives byte, age and count cleanup and is removed only by explicit reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-retained-'));
  try {
    const store = new Recordings(directory, 1, { maxAgeMs: 0, maxWorlds: 0 }); await store.open();
    for (const [id, parentId, tick] of [['root', undefined, 0], ['chosen', 'root', 1]] as const) {
      store.protect([id]);
      await store.record({ id, parentId, label: id, state: { tick } } as WorldView, Buffer.from(id));
      await store.retainPath(id); await store.flush();
    }
    store.protect([]); await store.collect();
    assert.equal(store.error, undefined);
    assert.equal(store.list().worlds.length, 2);
    assert.ok(store.list().retainedBytes > store.list().limit);
    const restored = new Recordings(directory, 1, { maxAgeMs: 0, maxWorlds: 0 }); await restored.open(); await restored.collect();
    assert.equal(restored.list().worlds.length, 2);
    assert.equal((await restored.path('chosen')).segments.length, 2);
    await restored.clearExcept('new-root');
    assert.equal(restored.list().worlds.length, 0); assert.equal(restored.list().bytes, 0);
    const empty = new Recordings(directory); await empty.open(); assert.equal(empty.list().worlds.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('replay reports missing ancestors instead of claiming a full run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-path-gap-'));
  try {
    const store = new Recordings(directory); await store.open();
    await store.record({ id: 'child', parentId: 'expired', label: 'child', state: { tick: 40 } } as WorldView, Buffer.from('frame'));
    const path = await store.path('child'); assert.equal(path.missingHistory, true); assert.equal(path.firstTick, 40);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
