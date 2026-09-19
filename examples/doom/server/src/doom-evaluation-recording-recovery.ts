import { join } from 'node:path';
import { z } from 'zod';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { ReplayPath } from '@multiverse/gameplay-harness';
import { Recordings } from './recordings.ts';
import { decodeDoomEvaluationRecordingManifest } from './doom-evaluation-recording-manifest.ts';

const sessionSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  view: z.object({ mainId: z.string().min(1) }),
  worlds: z.array(z.object({ view: z.object({ id: z.string().min(1), state: z.object({ tick: z.number().int().nonnegative() }) }) })),
});
const contractSchema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  contract: z.object({ id: z.string(), scenarios: z.array(z.object({ id: z.string() })) }) });

/** Caller holds exclusive application ownership and has already recovered evaluation VMs. */
export async function recoverDoomEvaluationRecordings(directory: string): Promise<void> {
  const manifest = await new JsonFileStore(join(directory, 'manifest.json'), value => contractSchema.parse(value)).load();
  if (!manifest) return;
  for (const scenario of manifest.contract.scenarios) for (const role of ['baseline', 'candidate']) {
    const id = contentRevision('doom-evaluation-run', `${manifest.contract.id}/${scenario.id}/${role}`).version.slice(7);
    await recoverDoomEvaluationRecording(join(directory, 'runs', id));
  }
}

/** Publish only committed footage from the durably saved main route. Never resume gameplay or change its result. */
export async function recoverDoomEvaluationRecording(directory: string): Promise<void> {
  const store = new JsonFileStore(join(directory, 'recording.json'), decodeDoomEvaluationRecordingManifest);
  const saved = await store.load();
  if (!saved || saved.state === 'finished') return;
  // Decode before opening a mutable store: unknown session/recording formats are left untouched.
  const session = await new JsonFileStore(join(directory, 'session.json'), value => sessionSchema.parse(value)).load();
  const main = session?.worlds.find(world => world.view.id === session.view.mainId)?.view;
  const recordings = new Recordings(join(directory, 'recordings'), 1024 ** 3, { maxAgeMs: 0, maxWorlds: 0 });
  await recordings.open();
  let path: ReplayPath | undefined;
  let error = 'Run interrupted. Recovered only committed footage up to the last saved main-session position.';
  if (main && recordings.list().worlds.some(world => world.id === main.id)) {
    // The session is authoritative. Retention flags alone do not establish that
    // a future won: they can be written before selection is committed.
    await recordings.retainPath(main.id);
    path = await recordings.path(main.id, main.state.tick);
    if (path.frames && path.lastTick < main.state.tick) {
      error = `Run interrupted. The final ${((main.state.tick - path.lastTick) / 35).toFixed(2)}s of saved gameplay was not recorded before the interruption.`;
    }
    await recordings.collect();
    if (recordings.error) throw new Error(recordings.error);
  } else {
    // Without an authoritative endpoint, preserve indexed footage rather than
    // guess which branch won or erase a possibly selected but unacknowledged path.
    error = 'Run interrupted. No recorded main route could be matched to the saved session; available footage was preserved.';
  }
  await store.save({ version: 1, state: 'finished', ...(path ? { path } : {}),
    ...(main ? { endpointTick: main.state.tick } : {}), error });
}
