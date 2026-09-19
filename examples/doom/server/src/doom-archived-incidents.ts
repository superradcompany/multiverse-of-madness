import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { SessionStore } from './persistence.ts';
import { doomLearningDirectory } from './doom-learning-lineage.ts';
import { decodeDoomLearningManifest, type DoomLearningManifest } from './doom-learning-manifest.ts';
import { decodeDoomSupervisor, type SavedDoomSupervisor } from './doom-supervisor.ts';
import type { DoomLearningHistory } from './doom-learning-history.ts';
import { decodeDoomLearningJobs } from './doom-learning-jobs.ts';
import { decodeDoomIncidents, DoomLearningIncidents } from './doom-learning-incidents.ts';
import { decodeDoomEvaluationVms, type DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';

type SnapshotPorts = Pick<DoomEvaluationVmPorts, 'snapshotIdentity' | 'collect'>;
const identity = z.object({ id: z.literal('doom-supervisor'), version: z.string().uuid() });

/** Caller owns the app data lease and serializes cleanup with background evaluation.
 * Only incident resource phases change. Policies, proposals, history and footage remain immutable.
 */
export async function collectDoomArchivedIncidents(dataDirectory: string,
  runtime: (manifest: DoomLearningManifest) => SnapshotPorts, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid archive cleanup time');
  const root = join(dataDirectory, 'learning');
  const files = ['session.json', ...(await readdir(dataDirectory)).filter(name => /^session-before-build-upgrade-\d+\.json$/.test(name))];
  const protectedBindings = new Map<string, VersionRef>(), protectedPoints = new Set<string>();
  for (const file of files) {
    await regular(join(dataDirectory, file), false);
    const saved = await new SessionStore(join(dataDirectory, file)).load();
    if (file === 'session.json' && !saved?.learning) return { released: [], deferred: [] };
    if (saved?.learning) protectedBindings.set(identity.parse(saved.learning.binding).version, saved.learning.binding);
    for (const point of saved?.recovery?.points ?? []) protectedPoints.add(point.reference);
  }
  const archived = new Map<string, SavedDoomSupervisor>();
  // Validate all roots/history before any physical deletion. Embedded history
  // retains policy evidence, but is not an execution-checkpoint retention root.
  for (const binding of protectedBindings.values()) {
    const directory = await checkedDirectory(root, binding);
    const manifest = await load(join(directory, 'manifest.json'), decodeDoomLearningManifest);
    if (!manifest) throw new Error('Missing rooted learning manifest');
    if (!manifest.history) continue;
    const history = await load(join(directory, 'history.json'), value => value as DoomLearningHistory);
    if (!history || history.version !== 1 || !same(history.revision, manifest.history)
      || !same(history.revision, contentRevision('doom-learning-history', { version: 1, lineages: history.lineages }))) throw new Error('Archive cleanup history content mismatch');
    for (const value of history.lineages) {
      const lineage = decodeDoomSupervisor(value), id = identity.parse(lineage.identity).version;
      if (archived.has(id) && !same(archived.get(id), lineage)) throw new Error('Conflicting archived learning history');
      archived.set(id, lineage);
    }
  }
  const deferred: Array<{ binding: string; reason: string }> = [];
  const plans: Array<{ directory: string; manifest: DoomLearningManifest; binding: string; retain: Set<string> }> = [];
  for (const [binding, expected] of archived) {
    if (protectedBindings.has(binding)) { deferred.push({ binding, reason: 'Retained by a session or rollback backup' }); continue; }
    const directory = await checkedDirectory(root, expected.identity);
    const supervisor = await load(join(directory, 'supervisor.json'), decodeDoomSupervisor);
    if (!same(supervisor, expected)) { deferred.push({ binding, reason: 'Archived supervisor changed since publication' }); continue; }
    const manifest = await load(join(directory, 'manifest.json'), decodeDoomLearningManifest);
    if (!manifest) throw new Error('Missing archived learning manifest');
    if (expected.journal.proposals.some(proposal => proposal.status === 'evaluating' || proposal.status === 'proposed' && proposal.expiresAt > now)) {
      deferred.push({ binding, reason: 'Unfinished or unexpired proposal' }); continue;
    }
    if (!await resourcesReleased(directory, expected.identity)) {
      deferred.push({ binding, reason: 'Unfinished job or resource cleanup' }); continue;
    }
    const incidents = await load(join(directory, 'incidents.json'), decodeDoomIncidents);
    if (!incidents) continue;
    plans.push({ directory, manifest, binding, retain: new Set(incidents.records.filter(record => protectedPoints.has(record.reference)).map(record => record.proposalId)) });
  }
  const released: string[] = [];
  for (const plan of plans) {
    const owner = await DoomLearningIncidents.open({ store: new JsonFileStore(join(plan.directory, 'incidents.json'), decodeDoomIncidents),
      capture: async () => { throw new Error('Archive cleanup cannot capture or run games'); }, runtime: runtime(plan.manifest) });
    const before = owner.snapshot().records.filter(record => record.phase !== 'released');
    await owner.collect(plan.retain);
    const after = owner.snapshot().records;
    for (const record of before) if (after.find(item => item.proposalId === record.proposalId)?.phase === 'released') released.push(record.reference);
    if (after.some(record => record.phase !== 'released')) deferred.push({ binding: plan.binding, reason: 'Checkpoint is retained or still has descendants' });
  }
  return { released, deferred };
}

async function resourcesReleased(directory: string, binding: VersionRef): Promise<boolean> {
  const jobs = await load(join(directory, 'jobs.json'), decodeDoomLearningJobs);
  if (jobs && !same(jobs.binding, binding)) throw new Error('Archived job ownership mismatch');
  if (jobs?.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status))) return false;
  for (const file of ['executor-runs.json', 'evaluation-executor-runs.json']) {
    const records = await load(join(directory, file), value => z.array(z.object({ phase: z.enum(['creating', 'running', 'released', 'cleanup-failed']) })).parse(value));
    if (records?.some(record => record.phase !== 'released')) return false;
  }
  for (const root of [join(directory, 'evaluations'), join(directory, 'evaluations', 'practice')]) {
    if (!await regular(root, true)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!z.string().uuid().safeParse(entry.name).success) continue;
      const path = join(root, entry.name); await regular(path, true);
      const resources = await load(join(path, 'resources.json'), decodeDoomEvaluationVms);
      if (resources?.runs.some(run => !run.closed || run.worlds.some(world => !world.released) || run.checkpoints.some(point => !point.released))) return false;
    }
  }
  return true;
}

async function checkedDirectory(root: string, binding: VersionRef): Promise<string> {
  await regular(root, true);
  await regular(join(root, 'supervisor.json'), false);
  const id = identity.parse(binding).version;
  if (await regular(join(root, 'lineages'), true)) {
    if (await regular(join(root, 'lineages', id), true)) await regular(join(root, 'lineages', id, 'supervisor.json'), false);
  }
  return doomLearningDirectory(root, binding);
}
async function regular(path: string, directory: boolean): Promise<boolean> {
  const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; });
  if (!info) return false;
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Archive cleanup requires regular owned paths');
  return true;
}
async function load<T>(path: string, decode: (value: unknown) => T): Promise<T | undefined> {
  if (!await regular(path, false)) return;
  return new JsonFileStore(path, decode).load();
}
function same(a: unknown, b: unknown) { return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b); }
