import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { decodeDoomLearningManifest } from './doom-learning-manifest.ts';
import { doomLearningDirectory } from './doom-learning-lineage.ts';
import type { DoomLearningHistory } from './doom-learning-history.ts';
import { SessionStore } from './persistence.ts';

const reference = z.strictObject({ id: z.string().min(1), version: z.string().min(1) });
const identity = z.strictObject({ id: z.literal('doom-supervisor'), version: z.string().uuid() });
const ownership = z.strictObject({ version: z.literal(1), id: z.string().uuid(), source: identity,
  prepared: z.strictObject({ identity, manifest: reference, supervisor: reference }).optional() });

/** Caller holds the application data lease. Ownership is recorded before any large files are staged. */
export async function beginDoomUpgradeWork(root: string, source: VersionRef) {
  const id = randomUUID(), work = join(root, '.upgrade-work', id), directory = join(work, 'lineage');
  await realDirectory(join(root, '.upgrade-work'), true);
  const record = ownership.parse({ version: 1, id, source });
  const store = new JsonFileStore(join(work, 'ownership.json'), value => ownership.parse(value));
  await store.save(record); await mkdir(directory);
  return { directory, publish: async (target: VersionRef) => {
    const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const supervisor = JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'));
    if (canonicalJson(supervisor.identity) !== canonicalJson(identity.parse(target))) throw new Error('Upgrade target identity mismatch');
    record.prepared = { identity: identity.parse(target), manifest: manifest.revision, supervisor: contentRevision('doom-upgrade-supervisor', supervisor) };
    await store.save(record); // A crash after rename still leaves exact ownership evidence.
    await realDirectory(join(root, 'lineages'), true);
    await rename(directory, join(root, 'lineages', target.version));
  } };
}

/** Include explicit rollback backups as roots; an abandoned build must not invalidate one. */
export async function doomUpgradeReferences(dataDirectory: string): Promise<VersionRef[]> {
  const files = ['session.json', ...(await readdir(dataDirectory)).filter(name => /^session-before-build-upgrade-\d+\.json$/.test(name))];
  const bindings: VersionRef[] = [];
  for (const file of files) {
    const saved = await new SessionStore(join(dataDirectory, file)).load();
    if (saved?.learning) bindings.push(saved.learning.binding);
  }
  return bindings;
}

/** Collect only marked upgrade work, under the same exclusive data lease as publication. */
export async function collectDoomUpgradeWork(root: string, bindings: readonly VersionRef[]) {
  const parent = join(root, '.upgrade-work');
  if (!await realDirectory(parent)) return { removed: [] as string[], retained: [] as string[] };
  if (!bindings.length) return { removed: [] as string[], retained: await readdir(parent) };
  // Validate every root before any deletion. History keeps previously published lineages live.
  const protectedIds = new Set<string>();
  for (const binding of bindings) {
    if (protectedIds.has(identity.parse(binding).version)) continue;
    protectedIds.add(identity.parse(binding).version);
    const directory = await doomLearningDirectory(root, binding);
    const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    if (manifest.history) {
      const history = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')) as DoomLearningHistory;
      if (history.version !== 1 || canonicalJson(history.revision) !== canonicalJson(manifest.history)
        || canonicalJson(contentRevision('doom-learning-history', { version: 1, lineages: history.lineages })) !== canonicalJson(history.revision)) throw new Error('Upgrade cleanup history content mismatch');
      for (const lineage of history.lineages) protectedIds.add(identity.parse(lineage.identity).version);
    }
  }
  const removed: string[] = [], retained: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) { retained.push(entry.name); continue; }
    const work = join(parent, entry.name), file = join(work, 'ownership.json');
    const stat = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; });
    if (!stat?.isFile() || stat.isSymbolicLink()) { retained.push(entry.name); continue; }
    const parsed = ownership.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success || parsed.data.id !== entry.name) { retained.push(entry.name); continue; }
    const target = parsed.data.prepared;
    if (target && !protectedIds.has(target.identity.version)) {
      await realDirectory(join(root, 'lineages'));
      const directory = join(root, 'lineages', target.identity.version);
      if (await realDirectory(directory)) {
        const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
        const supervisor = JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'));
        if (canonicalJson(manifest.revision) !== canonicalJson(target.manifest)
          || canonicalJson(contentRevision('doom-upgrade-supervisor', supervisor)) !== canonicalJson(target.supervisor)) {
          retained.push(entry.name); continue; // Changed since preparation: ownership is no longer sufficient.
        }
        await rm(directory, { recursive: true });
      }
    }
    await rm(work, { recursive: true }); removed.push(entry.name);
  }
  return { removed, retained };
}

async function realDirectory(path: string, create = false): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true });
  const stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Upgrade work path must be a real directory');
  return true;
}
