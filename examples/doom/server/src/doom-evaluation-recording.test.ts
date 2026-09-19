import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDoomEvaluationRecording, type DoomEvaluationRecordingManifest } from './doom-evaluation-recording.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { Recordings } from './recordings.ts';

test('recording finalization joins captured frames, seals admission and refuses to overwrite prior footage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-evaluation-recording-'));
  const session = new Session({ decide: async () => decision });
  try {
    await session.initialize(new Runtime('root'));
    const recording = await openDoomEvaluationRecording(directory);
    const view = session.snapshot(), world = view.worlds[0]!;
    await recording.record(world, session.frame(world.id));
    await recording.retainPath(world.id);
    const closing = recording.close(view);
    world.state.tick++;
    await assert.rejects(recording.record(world, Buffer.from('late frame')), /closed/);
    await closing;
    const path = join(directory, 'recording.json'), saved = await readFile(path, 'utf8');
    const manifest: DoomEvaluationRecordingManifest = JSON.parse(saved);
    assert.equal(manifest.state, 'finished');
    assert.equal(manifest.endpointTick, world.state.tick - 1);
    assert.equal(manifest.path!.frames, 1);
    assert.equal(manifest.error, undefined);
    await recording.close(view);
    await assert.rejects(openDoomEvaluationRecording(directory), /already exists/);
    assert.equal(await readFile(path, 'utf8'), saved);
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});

test('finalization collects discarded trials while preserving selected footage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-evaluation-gc-'));
  const session = new Session({ decide: async () => decision });
  try {
    await session.initialize(new Runtime('root'));
    const writer = await openDoomEvaluationRecording(directory), view = session.snapshot();
    const main = view.worlds[0]!, discarded = { ...structuredClone(main), id: 'discarded', parentId: main.id, role: 'experiment' as const };
    writer.update({ ...view, worlds: [main, discarded] });
    await writer.record(main, session.frame(main.id)); await writer.retainPath(main.id);
    await writer.record(discarded, Buffer.from('discarded trial'));
    await writer.close(view);
    const reader = new Recordings(join(directory, 'recordings')); await reader.open();
    assert.deepEqual(reader.list().worlds.map(world => world.id), [main.id]);
    assert.equal((await reader.path(main.id)).frames, 1);
    await assert.rejects(reader.get(discarded.id, 0));
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});
