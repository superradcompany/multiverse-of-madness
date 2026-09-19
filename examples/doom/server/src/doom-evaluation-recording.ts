import { join } from 'node:path';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { ReplayPath } from '@multiverse/gameplay-harness';
import type { SessionView, WorldView } from '../../contracts/src/session.ts';
import { BufferedRecorder } from './buffered-recorder.ts';
import { Recordings } from './recordings.ts';

/** One evaluation run owns its footage independently of the live game's recordings. */
export interface DoomRunRecording {
  record(world: WorldView, frame: Buffer): Promise<void>;
  retainPath(id: string): Promise<void>;
  update(view: SessionView): void;
  close(view: SessionView): Promise<void>;
}
export interface DoomEvaluationRecordingManifest {
  version: 1;
  state: 'recording' | 'finished';
  /** Selected ancestry observed in this test run, starting at its scenario state. */
  path?: ReplayPath;
  /** Final observed main-world tick, used to detect an incompletely recorded tail. */
  endpointTick?: number;
  error?: string;
}

/** Bounded buffering and ordinary replay segments; no sampling or synthetic frames. */
export async function openDoomEvaluationRecording(directory: string): Promise<DoomRunRecording> {
  const manifest = new JsonFileStore<DoomEvaluationRecordingManifest>(join(directory, 'recording.json'), value => value as DoomEvaluationRecordingManifest);
  if (await manifest.load()) throw new Error('Evaluation recording already exists; cannot overwrite a previous run');
  // Evaluation spectators retain selected routes. Discarded trial footage can
  // be reclaimed as soon as it is no longer protected by the running session.
  const recordings = new Recordings(join(directory, 'recordings'), 1024 ** 3, { maxAgeMs: 0, maxWorlds: 0 });
  await recordings.open();
  await manifest.save({ version: 1, state: 'recording' });
  const buffer = new BufferedRecorder((world, frame) => recordings.record(world, frame));
  let sealed = false, closing: Promise<void> | undefined;
  return {
    record: (world, frame) => {
      if (sealed) return Promise.reject(new Error('Evaluation recording is closed'));
      return buffer.record(world, frame);
    },
    retainPath: id => recordings.retainPath(id),
    update: view => recordings.protect(view.worlds.filter(world => world.role !== 'archived').map(world => world.id)),
    close: view => {
      if (closing) return closing;
      sealed = true;
      const captured = structuredClone(view);
      closing = (async () => {
        // Recording calls synchronously enter the owner's queue. Joining flush
        // therefore includes every buffered call before publishing the manifest.
        await recordings.flush();
        recordings.protect([]);
        await recordings.collect();
        const main = captured.worlds.find(world => world.id === captured.mainId);
        let path: ReplayPath | undefined, error = recordings.error;
        if (main) {
          try { path = await recordings.path(main.id, main.state.tick); }
          catch { error ??= 'Selected gameplay recording is unavailable'; }
          if (path && (path.missingHistory || path.lastTick !== main.state.tick)) error ??= 'Selected gameplay recording is incomplete';
        }
        await manifest.save({ version: 1, state: 'finished', ...(path ? { path } : {}),
          ...(main ? { endpointTick: main.state.tick } : {}), ...(error ? { error } : {}) });
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
}
