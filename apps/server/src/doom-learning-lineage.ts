import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, type VersionRef } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { decodeDoomSupervisor } from './doom-supervisor.ts';
import { DoomLearningModels } from './doom-learning-models.ts';
import { verifyDoomLearningHistory, type DoomLearningHistory, type DoomHistoricalResolver } from './doom-learning-history.ts';

/** The session checkpoint's binding selects a lineage; there is no second mutable active pointer. */
export async function doomLearningDirectory(root: string, expected?: VersionRef): Promise<string> {
  if (!expected) return root;
  const identity = z.strictObject({ id: z.literal('doom-supervisor'), version: z.string().uuid() }).parse(expected);
  const original = await new JsonFileStore(join(root, 'supervisor.json'), decodeDoomSupervisor).load();
  if (original && canonicalJson(original.identity) === canonicalJson(identity)) return root;
  const directory = join(root, 'lineages', identity.version);
  const saved = await new JsonFileStore(join(directory, 'supervisor.json'), decodeDoomSupervisor).load();
  if (!saved || canonicalJson(saved.identity) !== canonicalJson(identity)) throw new Error('Missing or mismatched Doom learning lineage');
  return directory;
}

/** Admission validates archived data/source; historical code is never run by the new host. */
export async function readDoomLearningHistory(directory: string, expected: VersionRef, observe?: (history: DoomLearningHistory) => void): Promise<DoomHistoricalResolver> {
  const history = await new JsonFileStore(join(directory, 'history.json'), value => value as DoomLearningHistory).load();
  if (!history || canonicalJson(history.revision) !== canonicalJson(expected)) throw new Error('Missing or mismatched Doom learning history');
  const registries = new Map<string, DoomLearningModels>();
  const resolver = await verifyDoomLearningHistory(history, async (artifact, lineage) => {
    let models = registries.get(lineage.identity.version);
    if (!models) {
      const initial = lineage.journal.artifacts.find(item => canonicalJson(item.revision) === canonicalJson(lineage.journal.initial));
      if (!initial || initial.adapter.id !== 'doom-learning-adapter') throw new Error('Unsupported historical Doom adapter');
      models = new DoomLearningModels({ adapter: initial.adapter,
        builtinExecutor: { id: 'doom-jev-host', version: initial.adapter.version }, profile: 'game-aware',
        executables: new ExecutableStore(join(directory, 'executables')),
        executable: () => { throw new Error('Historical code cannot execute'); } });
      registries.set(lineage.identity.version, models);
    }
    await models.verify(artifact);
  });
  observe?.(structuredClone(history));
  return resolver;
}
