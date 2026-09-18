import { resolve, join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { acquireDataLease } from '../apps/server/src/data-lease.ts';
import { SessionStore } from '../apps/server/src/persistence.ts';
import { readDoomLearningBuild } from '../apps/server/src/doom-learning-build.ts';
import { prepareDoomBuildUpgrade } from '../apps/server/src/doom-learning-upgrade.ts';
import { collectDoomUpgradeWork, doomUpgradeReferences } from '../apps/server/src/doom-upgrade-work.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: tsx scripts/upgrade-gameplay-build.ts DATA_DIRECTORY (stop its server first)');
const lease = await acquireDataLease(resolve(directory));
try {
  const path = join(lease.directory, 'session.json'), store = new SessionStore(path);
  const saved = await store.load();
  if (!saved) throw new Error('No saved gameplay session');
  await collectDoomUpgradeWork(join(lease.directory, 'learning'), await doomUpgradeReferences(lease.directory));
  const next = await prepareDoomBuildUpgrade(join(lease.directory, 'learning'), saved, await readDoomLearningBuild());
  await copyFile(path, join(lease.directory, `session-before-build-upgrade-${Date.now()}.json`));
  await store.save(next); await store.flush();
  await collectDoomUpgradeWork(join(lease.directory, 'learning'), await doomUpgradeReferences(lease.directory));
  console.log(JSON.stringify({ binding: next.learning!.binding, mainId: next.view.mainId, retainedWorlds: next.worlds.length }));
} finally { await lease.release(); }
