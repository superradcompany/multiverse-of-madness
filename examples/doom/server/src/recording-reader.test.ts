import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recordings } from './recordings.ts';
import { RecordingReader } from './recording-reader.ts';
import type { WorldView } from '../../contracts/src/session.ts';

test('spectator reads cross committed and pending frames and respect recording deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mom-reader-'));
  try {
    const store = new Recordings(root); await store.open();
    const reader = new RecordingReader(root, store);
    const world = { id: 'world', label: 'test', state: { tick: 0 } } as WorldView;
    for (let tick = 0; tick < 40; tick++) {
      world.state.tick = tick; await store.record(world, Buffer.from(`frame-${tick}`));
    }
    const frames = await Promise.all([0, 1, 34, 35, 39].map(frame => reader.get('world', frame)));
    assert.deepEqual(frames.map(frame => frame.world.state.tick), [0, 1, 34, 35, 39]);
    assert.equal(Buffer.from(frames[2]!.frame, 'base64').toString(), 'frame-34');
    await store.flush();
    assert.equal((await reader.get('world', 39)).world.state.tick, 39);
    await assert.rejects(reader.get('world', -1), /not found/);
    await assert.rejects(reader.get('world', 40), /not found/);
    await store.clearExcept('new-root');
    await assert.rejects(reader.get('world', 0), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spectator cache respects rolling retention and stable frame positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mom-reader-retention-'));
  try {
    const initial = new Recordings(root); await initial.open();
    const world = { id: 'world', label: 'test', state: { tick: 0 } } as WorldView;
    for (let tick = 0; tick < 35; tick++) { world.state.tick = tick; await initial.record(world, Buffer.from(`frame-${tick}`)); }
    const store = new Recordings(root, initial.list().bytes + 100); await store.open();
    const reader = new RecordingReader(root, store);
    assert.equal((await reader.get('world', 0)).world.state.tick, 0);
    for (let tick = 35; tick < 105; tick++) { world.state.tick = tick; await store.record(world, Buffer.from(`frame-${tick}`)); }
    await assert.rejects(reader.get('world', 0), /not found/);
    assert.equal((await reader.get('world', 70)).world.state.tick, 70);
  } finally { await rm(root, { recursive: true, force: true }); }
});
