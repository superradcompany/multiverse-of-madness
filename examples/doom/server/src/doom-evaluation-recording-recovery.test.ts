import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { WorldView } from '../../contracts/src/session.ts';
import { Recordings } from './recordings.ts';
import { DoomEvaluationReplay } from './doom-evaluation-replay.ts';
import { recoverDoomEvaluationRecording } from './doom-evaluation-recording-recovery.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'doom-recording-recovery-'));
  const save = (path: string, value: unknown) => new JsonFileStore(join(directory, path), value => value).save(value);
  const load = async (path: string) => JSON.parse(await readFile(join(directory, path), 'utf8'));
  await save('recording.json', { version: 1, state: 'recording' });
  const recordings = new Recordings(join(directory, 'recordings')); await recordings.open();
  const world = (id: string, parentId?: string) => ({ id, label: id, parentId, role: 'main', state: { tick: 0, health: 90, kills: 2 } }) as WorldView;
  const record = async (world: WorldView, start: number, end: number) => {
    for (let tick = start; tick <= end; tick++) { world.state.tick = tick; await recordings.record(world, Buffer.from(`${world.id}-${tick}`)); }
  };
  return { directory, save, load, recordings, world, record, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('recovery uses the saved main route, not newer retained futures, and leaves outcome evidence unchanged', async () => {
  const f = await fixture();
  try {
    const main = f.world('main'), future = f.world('future', main.id), discarded = f.world('discarded', main.id);
    await f.record(main, 0, 10); await f.recordings.retainPath(main.id);
    await f.save('session.json', { version: 1, view: { mainId: main.id }, worlds: [{ view: main }] });
    // Retention can precede a winner's durable commit, so this is not authority to promote it.
    await f.record(future, 10, 20); await f.recordings.retainPath(future.id);
    await f.record(discarded, 10, 18); await f.recordings.flush();
    await f.save('result.json', { status: 'error', error: 'interrupted before result publication' });
    const result = await readFile(join(f.directory, 'result.json'), 'utf8');
    await recoverDoomEvaluationRecording(f.directory);
    const recovered = await f.load('recording.json');
    assert.equal(recovered.state, 'finished'); assert.match(recovered.error, /interrupted/);
    assert.equal(recovered.path.endpointId, main.id); assert.equal(recovered.path.lastTick, 10);
    const frames = await new DoomEvaluationReplay(f.directory, recovered).frames(0, 35);
    assert.deepEqual(frames.map(frame => frame.tick), Array.from({ length: 11 }, (_, index) => index));
    const reopened = new Recordings(join(f.directory, 'recordings')); await reopened.open();
    assert.deepEqual(reopened.list().worlds.map(world => world.id).sort(), ['future', 'main']);
    assert.equal(await readFile(join(f.directory, 'result.json'), 'utf8'), result);
    const published = await readFile(join(f.directory, 'recording.json'), 'utf8');
    await recoverDoomEvaluationRecording(f.directory);
    assert.equal(await readFile(join(f.directory, 'recording.json'), 'utf8'), published);
  } finally { await f.cleanup(); }
});

test('missing saved main preserves footage without inventing a selected route', async () => {
  const f = await fixture();
  try {
    await f.record(f.world('unacknowledged'), 0, 4); await f.recordings.flush();
    await recoverDoomEvaluationRecording(f.directory);
    const saved = await f.load('recording.json');
    assert.equal(saved.path, undefined); assert.match(saved.error, /No recorded main route/);
    const reopened = new Recordings(join(f.directory, 'recordings')); await reopened.open();
    assert.equal(reopened.list().worlds[0]!.frames, 5);
  } finally { await f.cleanup(); }
});

test('a durably selected future recovers its parent ancestry and stops at the saved position', async () => {
  const f = await fixture();
  try {
    const root = f.world('root'), selected = f.world('selected', root.id);
    await f.record(root, 0, 10); await f.recordings.retainPath(root.id);
    await f.record(selected, 10, 20); await f.recordings.retainPath(selected.id);
    await f.save('session.json', { version: 3, view: { mainId: selected.id }, worlds: [{ view: root }, { view: selected }] });
    await f.record(selected, 21, 25); await f.recordings.flush();
    await recoverDoomEvaluationRecording(f.directory);
    const recovered = await f.load('recording.json');
    assert.equal(recovered.path.lastTick, 20); assert.equal(recovered.endpointTick, 20);
    assert.equal(recovered.path.missingHistory, false);
    assert.deepEqual(recovered.path.segments.map((segment: { worldId: string }) => segment.worldId), ['root', 'selected']);
    const frames = await new DoomEvaluationReplay(f.directory, recovered).frames(8, 35);
    assert.deepEqual(frames.map(frame => Buffer.from(frame.frame, 'base64').toString()),
      Array.from({ length: 13 }, (_, index) => `${index + 8 <= 10 ? 'root' : 'selected'}-${index + 8}`));
  } finally { await f.cleanup(); }
});

test('unknown formats stay untouched and failed manifest publication is retryable', async () => {
  const f = await fixture();
  try {
    const main = f.world('main'); await f.record(main, 0, 4); await f.recordings.flush();
    await f.save('session.json', { version: 99, view: { mainId: main.id }, worlds: [{ view: main }] });
    const before = await readFile(join(f.directory, 'recording.json'), 'utf8');
    await assert.rejects(recoverDoomEvaluationRecording(f.directory));
    assert.equal(await readFile(join(f.directory, 'recording.json'), 'utf8'), before);
    await f.save('session.json', { version: 1, view: { mainId: main.id }, worlds: [{ view: main }] });
    // Block atomic publication without making the already captured footage unwritable.
    await mkdir(join(f.directory, 'recording.json.tmp'));
    await assert.rejects(recoverDoomEvaluationRecording(f.directory));
    assert.equal(await readFile(join(f.directory, 'recording.json'), 'utf8'), before);
    await rm(join(f.directory, 'recording.json.tmp'), { recursive: true });
    await recoverDoomEvaluationRecording(f.directory);
    assert.equal((await f.load('recording.json')).path.frames, 5);
    await writeFile(join(f.directory, 'recording.json'), JSON.stringify({ version: 99, state: 'recording' }));
    await assert.rejects(recoverDoomEvaluationRecording(f.directory));
    assert.equal((await f.load('recording.json')).version, 99);
  } finally { await f.cleanup(); }
});

test('SIGKILL recovery exposes committed frames and reports the missing buffered tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-recording-killed-'));
  const child = fork(fileURLToPath(new URL('../test-support/evaluation-recording-process.ts', import.meta.url)), [directory],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', value => { diagnostics += String(value); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Recorder fixture did not start: ' + diagnostics)), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Recorder fixture exited: ' + diagnostics)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.kill('SIGKILL'); await exited;
    assert.equal(child.signalCode, 'SIGKILL');
    await recoverDoomEvaluationRecording(directory);
    const manifest = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
    assert.equal(manifest.path.frames, 36); assert.equal(manifest.path.lastTick, 35);
    assert.equal(manifest.endpointTick, 40); assert.match(manifest.error, /interrupted/);
    const tail = await new DoomEvaluationReplay(directory, manifest).frames(30, 35);
    assert.deepEqual(tail.map(frame => Buffer.from(frame.frame, 'base64').toString()), ['frame-30', 'frame-31', 'frame-32', 'frame-33', 'frame-34', 'frame-35']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(directory, { recursive: true, force: true });
  }
});
