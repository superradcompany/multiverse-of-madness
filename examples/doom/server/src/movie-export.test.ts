import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { MovieExports } from './movie-export.ts';
import { Recordings } from './recordings.ts';
import type { WorldView } from '../../contracts/src/session.ts';

const binary: string = createRequire(import.meta.url)('ffmpeg-static');
function png(red: number, green: number) {
  const image = new PNG({ width: 2, height: 2 });
  for (let n = 0; n < 16; n += 4) image.data.set([red, green, 0, 255], n);
  return PNG.sync.write(image);
}
async function completed(movies: MovieExports, id: string) {
  const deadline = Date.now() + 20_000;
  while (movies.get(id).status === 'encoding') {
    if (Date.now() > deadline) throw new Error('Export timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return movies.get(id);
}
test('MP4 follows selected ancestry, preserves sparse timing and respects the endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-movie-'));
  const recordings = new Recordings(join(directory, 'recordings'));
  const movies = new MovieExports(recordings, join(directory, 'exports'));
  try {
    await recordings.open(); await movies.open();
    for (const [id, parentId, ticks, color] of [
      ['root', undefined, [0, 5, 10], png(255, 0)],
      ['winner', 'root', [10, 15, 20], png(0, 255)],
      ['loser', 'root', [10, 15, 20], png(255, 255)],
    ] as const) for (const tick of ticks) await recordings.record({ id, parentId, label: id, state: { tick } } as WorldView, color);
    const job = await movies.start('winner', 15);
    await assert.rejects(movies.start('winner', 20), /Another movie/);
    const result = await completed(movies, job.id);
    assert.equal(result.status, 'ready', result.error);
    assert.equal(result.progress, 100);
    const file = movies.file(job.id);
    assert.equal((await readFile(file)).subarray(4, 8).toString(), 'ftyp');
    const decoded = spawnSync(binary, ['-v', 'error', '-i', file, '-vf', 'scale=2:2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.equal(decoded.stdout.length, 16 * 2 * 2 * 3); // positions 0 through 15, at 35 fps
    assert.ok(decoded.stdout[0]! > 240 && decoded.stdout[1]! < 10);
    const end = decoded.stdout.subarray(-12);
    assert.ok(end[0]! < 10 && end[1]! > 240); // winner, never discarded sibling
    assert.deepEqual((await recordings.path('winner')).segments.map(s => s.worldId), ['root', 'winner']);
  } finally { await movies.close(); await rm(directory, { recursive: true, force: true }); }
});

test('missing history requires explicit partial export and cancellation leaves no movie', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-movie-cancel-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const movies = new MovieExports({
    path: async () => ({ endpointId: 'orphan', segments: [{ worldId: 'orphan', label: 'orphan', firstFrame: 0, ticks: [20] }], frames: 1, firstTick: 20, lastTick: 20, missingHistory: true }),
    get: async () => { await gate; return { world: { state: { tick: 20 } } as WorldView, at: 0, frame: png(255, 0).toString('base64') }; },
  }, directory);
  try {
    await movies.open();
    await assert.rejects(movies.start('orphan', 20), /Earlier footage/);
    const job = await movies.start('orphan', 20, false, true);
    const cancelled = movies.cancel(job.id); release(); await cancelled;
    assert.equal(movies.get(job.id).status, 'cancelled');
    assert.throws(() => movies.file(job.id), /not ready/);
    assert.deepEqual(await readdir(directory), []);
  } finally { release(); await movies.close(); await rm(directory, { recursive: true, force: true }); }
});

test('encoder failure is reported and incomplete files are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-movie-error-'));
  const recordings = new Recordings(join(directory, 'recordings'));
  const movies = new MovieExports(recordings, join(directory, 'exports'));
  try {
    await recordings.open(); await movies.open();
    await recordings.record({ id: 'bad', label: 'bad', state: { tick: 0 } } as WorldView, Buffer.from('invalid png'));
    const job = await movies.start('bad', 0);
    assert.equal((await completed(movies, job.id)).status, 'error');
    assert.deepEqual(await readdir(join(directory, 'exports')), []);
  } finally { await movies.close(); await rm(directory, { recursive: true, force: true }); }
});
