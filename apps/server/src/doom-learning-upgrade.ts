import { doomAutonomousState } from './doom-autonomous-learning.ts';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { beginDoomUpgradeWork } from './doom-upgrade-work.ts';
import { canonicalJson } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore, contentRevision } from '@multiverse/gameplay-harness/node';
import type { SessionCheckpoint } from './session.ts';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { decodeDoomLearningManifest, type DoomLearningManifest } from './doom-learning-manifest.ts';
import { doomLearningDirectory, readDoomLearningHistory } from './doom-learning-lineage.ts';
import { doomLearningHistory, type DoomLearningHistory } from './doom-learning-history.ts';
import { decodeDoomSupervisor, DoomSupervisor } from './doom-supervisor.ts';
import { retainDoomLearningBuild, type DoomLearningBuild } from './doom-learning-build.ts';

/** Explicit offline handoff. Caller owns the data lease and publishes the returned checkpoint last. */
export async function prepareDoomBuildUpgrade(root: string, saved: SessionCheckpoint, build: DoomLearningBuild): Promise<SessionCheckpoint> {
  if (!saved.learning || saved.version !== 2) throw new Error('Build upgrade requires a supervised session');
  if (saved.view.running || saved.experiments.length || saved.pendingFork || saved.worlds.some(w => w.view.role !== 'archived'
    && (w.plan?.status === 'running' || w.view.controller === 'human'))) throw new Error('Pause at a resolved AI decision boundary before upgrading');
  const source = await doomLearningDirectory(root, saved.learning.binding);
  const manifest = await new JsonFileStore(join(source, 'manifest.json'), decodeDoomLearningManifest).load();
  const old = await new JsonFileStore(join(source, 'supervisor.json'), decodeDoomSupervisor).load();
  if (!manifest || !old) throw new Error('Missing original learning lineage');
  if (canonicalJson(manifest.build) === canonicalJson(build)) return structuredClone(saved);
  const previous = manifest.history ? await new JsonFileStore(join(source, 'history.json'), value => value as DoomLearningHistory).load() : undefined;
  if (manifest.history) await readDoomLearningHistory(source, manifest.history);
  const history = doomLearningHistory([...(previous?.lineages ?? []), old]);
  const work = await beginDoomUpgradeWork(root, saved.learning.binding);
  const directory = work.directory;
  await cp(join(source, 'executables'), join(directory, 'executables'), { recursive: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await new JsonFileStore(join(directory, 'history.json'), value => value as DoomLearningHistory).save(history);
  const historical = await readDoomLearningHistory(directory, history.revision);
  const current = old.journal.artifacts.find(a => canonicalJson(a.revision) === canonicalJson(old.journal.active.revision));
  if (!current) throw new Error('Missing current learning artifact');
  const { revision: _revision, ...fields } = current;
  const adapter = { id: 'doom-learning-adapter', version: build.revision.version };
  const builtinExecutor = { id: 'doom-jev-host', version: build.revision.version };
  // Carry over the selected planner as a new baseline, never its old qualification.
  const initial = doomLearningArtifact({ ...fields, adapter,
    executor: fields.executor.id === 'doom-jev-host' ? builtinExecutor : fields.executor });
  const models = new DoomLearningModels({ adapter, builtinExecutor, profile: 'game-aware',
    executables: new ExecutableStore(join(directory, 'executables')),
    executable: () => { throw new Error('Upgrade validation cannot execute gameplay'); } });
  await models.verify(initial);
  const contract = { ...manifest.contract, evaluator: build.revision, allowance: 'complete-futures-v1' as const };
  const next = await DoomSupervisor.open({ initial, models, historical,
    store: new JsonFileStore(join(directory, 'supervisor.json'), decodeDoomSupervisor),
    rules: { ...old.journal.rules, contract: contentRevision('doom-evaluation-contract', contract) },
    qualify: async () => { throw new Error('Upgrade validation cannot launch experiments'); } });
  // The directory must agree with the immutable identity chosen by the controller.
  await retainDoomLearningBuild(join(directory, 'build'), build);
  const { revision: _manifestRevision, ...oldFields } = manifest;
  const nextFields = { ...oldFields, version: 2 as const, build, initial, contract, history: history.revision };
  const nextManifest: DoomLearningManifest = { ...nextFields, revision: contentRevision('doom-learning-service', nextFields) };
  await new JsonFileStore(join(directory, 'manifest.json'), decodeDoomLearningManifest).save(nextManifest);
  const automation = await new JsonFileStore(join(source, 'automation.json'), value => doomAutonomousState.parse(value)).load();
  if (automation) {
    // Preserve request spacing and the user's on/off choice. Old jobs stay in
    // historical storage; they cannot resume against changed executable code.
    const { cycle: _cycle, error: _error, ...rest } = automation;
    await new JsonFileStore(join(directory, 'automation.json'), value => doomAutonomousState.parse(value)).save(rest);
  }
  for (const file of ['automation-preferences.json', 'automation-goal.json']) {
    await cp(join(source, file), join(directory, file)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  await next.close();
  await work.publish(next.binding.identity);
  const checkpoint = structuredClone(saved);
  checkpoint.learning!.binding = next.binding.identity;
  return checkpoint;
}
