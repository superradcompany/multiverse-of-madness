import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomLearningService } from './doom-learning-service.ts';
import { DoomLearningIncidents, decodeDoomIncidents } from './doom-learning-incidents.ts';
import { prepareDoomBuildUpgrade } from './doom-learning-upgrade.ts';
import { collectDoomArchivedIncidents } from './doom-archived-incidents.ts';
import { SessionStore } from './persistence.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

/** Real stores and build handoff, in-memory runtime only. No CLI/model/VM calls. */
async function fixture(proposal = false) {
  const data = await mkdtemp(join(tmpdir(), 'doom-archives-')), directory = join(data, 'learning');
  const points = new Map<string, string>();
  let descendants = false, loseAck = false, calls = 0;
  const runtime = {
    snapshotIdentity: async (ref: string) => points.get(ref),
    collect: async (requested: Array<{ reference: string; identity?: string }>) => {
      calls++;
      if (descendants) return requested.map(point => point.reference);
      for (const point of requested) {
        if (points.has(point.reference)) assert.equal(point.identity, points.get(point.reference));
        points.delete(point.reference);
      }
      if (loseAck) { loseAck = false; throw new Error('delete acknowledgement lost'); }
      return [];
    },
    create: async () => { throw new Error('No VM may start'); }, destroy: async () => {},
    capture: async () => { throw new Error('No VM may capture'); }, restore: async () => { throw new Error('No VM may restore'); },
    parentSnapshot: async () => undefined,
  };
  const fields = { node: process.version, files: {} }, build = { ...fields, revision: contentRevision('fixture-build', fields) };
  const service = await DoomLearningService.open({ directory, build, image: 'docker.io/library/node@sha256:' + 'a'.repeat(64),
    profile: 'game-aware', backgroundLearning: false, bootstrapPlanner: false, runtime,
    modelClient: { systemOne: () => { throw new Error('No model may run'); } },
    proposalProvider: async record => ({ version: { id: 'fixture', version: '1' }, propose: async request => {
      const response = { draft: { kind: 'guidance', reason: 'Fixture proposal', prompts: { action: 'Measure progress.' } },
        receipt: { id: request.id, provider: { id: 'fixture', version: '1' }, startedAt: Date.now(), elapsedMs: 1,
          inputBytes: 1, outputBytes: 1, requestedModel: 'fixture', servingModels: ['fixture'], status: 'complete' as const,
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 } } };
      await record(response); return response;
    } }) });
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('archive-source'));
  const store = new SessionStore(join(data, 'session.json')); session.setPersistence(saved => store.save(saved));
  session.setCheckpointAdapter({ capture: async (_world, ref) => { points.set(ref, 'physical-' + ref); },
    restore: runtime.restore, remove: async ref => { points.delete(ref); } });
  await service.attach(session); await service.enable();
  if (proposal) {
    await service.start({ kind: 'propose', id: randomUUID(), proposalKind: 'guidance' });
    const deadline = Date.now() + 5000;
    while (service.view().busy) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(service.view().proposals[0]!.status, 'proposed');
  }
  await service.close();
  const saved = session.checkpoint(); await store.save(saved);
  const owner = await DoomLearningIncidents.open({ store: new JsonFileStore(join(directory, 'incidents.json'), decodeDoomIncidents), runtime,
    capture: async reference => { points.set(reference, 'physical-' + reference); return session.checkpoint(); } });
  const captured = await owner.capture(randomUUID(), new AbortController().signal);
  const upgrade = () => prepareDoomBuildUpgrade(directory, saved, { ...build, revision: contentRevision('fixture-build', { next: true }) });
  const current = await upgrade(); await store.save(current);
  return { data, directory, saved, current, captured, points, store, upgrade, runtime, get calls() { return calls; },
    openCurrent: () => DoomLearningService.open({ directory, build: { ...build, revision: contentRevision('fixture-build', { next: true }) },
      image: 'docker.io/library/node@sha256:' + 'a'.repeat(64), profile: 'game-aware', backgroundLearning: false, bootstrapPlanner: false, runtime,
      modelClient: { systemOne: () => { throw new Error('No model may run'); } } }, current.learning!.binding),
    collect: (now?: number) => collectDoomArchivedIncidents(data, () => runtime, now),
    descendants: (value: boolean) => { descendants = value; }, loseAck: () => { loseAck = true; },
    close: () => rm(data, { recursive: true, force: true }) };
}

test('archived snapshots retire idempotently without changing immutable history or evidence', async () => {
  const f = await fixture();
  try {
    const paths = ['supervisor.json', 'manifest.json', 'lineages/' + f.current.learning!.binding.version + '/history.json'];
    const before = await Promise.all(paths.map(path => readFile(join(f.directory, path), 'utf8')));
    assert.deepEqual((await f.collect()).released, [f.captured.snapshot.reference]); assert.equal(f.points.size, 0);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(f.directory, path), 'utf8'))), before);
    const incidents = decodeDoomIncidents(JSON.parse(await readFile(join(f.directory, 'incidents.json'), 'utf8')));
    assert.equal(incidents.records[0]!.phase, 'released'); assert.deepEqual(incidents.records[0]!.evidence, f.captured.evidence);
    assert.deepEqual(await f.collect(), { released: [], deferred: [] }); assert.equal(f.calls, 1);
  } finally { await f.close(); }
});

test('rollback backups and session recovery references protect archived checkpoints', async () => {
  const f = await fixture();
  try {
    const backup = join(f.data, 'session-before-build-upgrade-123.json'); await new SessionStore(backup).save(f.saved);
    assert.match((await f.collect()).deferred[0]!.reason, /backup/); assert.equal(f.calls, 0);
    await rm(backup);
    const saved = structuredClone(f.current); assert.ok(saved.recovery);
    const world = saved.worlds.find(world => world.view.id === saved.view.mainId)!;
    assert.ok(world.stats);
    saved.recovery.points.push({ id: randomUUID(), reference: f.captured.snapshot.reference, createdAt: Date.now(),
      world: world.view, history: world.history, stats: world.stats });
    await f.store.save(saved); assert.match((await f.collect()).deferred[0]!.reason, /retained/); assert.equal(f.calls, 0);
    await f.store.save(f.current); assert.equal((await f.collect()).released.length, 1);
  } finally { await f.close(); }
});

test('descendant retention and lost deletion acknowledgement converge on a later collection', async () => {
  const f = await fixture();
  try {
    f.descendants(true); assert.match((await f.collect()).deferred[0]!.reason, /descendants/); assert.equal(f.points.size, 1);
    f.descendants(false); f.loseAck(); await assert.rejects(f.collect(), /acknowledgement lost/); assert.equal(f.points.size, 0);
    assert.deepEqual((await f.collect()).released, [f.captured.snapshot.reference]);
    assert.deepEqual(await f.collect(), { released: [], deferred: [] });
  } finally { await f.close(); }
});

test('unfinished executor, evaluation and practice resources defer retirement', async () => {
  const f = await fixture();
  try {
    for (const name of ['executor-runs.json', 'evaluation-executor-runs.json']) {
      const path = join(f.directory, name); await writeFile(path, JSON.stringify([{ phase: 'running' }]));
      assert.match((await f.collect()).deferred[0]!.reason, /resource/); assert.equal(f.calls, 0); await rm(path);
    }
    for (const name of ['evaluations', 'evaluations/practice']) {
      const path = join(f.directory, name, randomUUID()); await mkdir(path, { recursive: true });
      const resources = { version: 1, owner: randomUUID(), runs: [{ id: 'trial', closed: false, worlds: [], checkpoints: [] }] };
      await writeFile(join(path, 'resources.json'), JSON.stringify(resources));
      assert.match((await f.collect()).deferred[0]!.reason, /resource/); assert.equal(f.calls, 0);
      resources.runs[0]!.closed = true; await writeFile(join(path, 'resources.json'), JSON.stringify(resources));
    }
    assert.equal((await f.collect()).released.length, 1);
  } finally { await f.close(); }
});

test('changed history, supervisor and physical identities never authorize snapshot removal', async () => {
  const f = await fixture();
  try {
    const history = join(f.directory, 'lineages', f.current.learning!.binding.version, 'history.json');
    const original = await readFile(history, 'utf8'), changed = JSON.parse(original); changed.lineages = [];
    await writeFile(history, JSON.stringify(changed)); await assert.rejects(f.collect(), /history content mismatch/); assert.equal(f.calls, 0);
    await writeFile(history, original);
    const path = join(f.directory, 'supervisor.json'), text = await readFile(path, 'utf8'), supervisor = JSON.parse(text);
    supervisor.journal.extra = true; await writeFile(path, JSON.stringify(supervisor));
    assert.match((await f.collect()).deferred[0]!.reason, /changed/); assert.equal(f.calls, 0); await writeFile(path, text);
    f.points.set(f.captured.snapshot.reference, 'replacement'); await assert.rejects(f.collect(), /identity changed/); assert.equal(f.calls, 0);
  } finally { await f.close(); }
});

test('symlinked journals are refused before any physical cleanup', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'incidents.json'); await rename(path, path + '.original'); await symlink(path + '.original', path);
    await assert.rejects(f.collect(), /regular owned paths/); assert.equal(f.calls, 0);
  } finally { await f.close(); }
});


test('an unexpired archived proposal keeps its borrowed incident until expiry', async () => {
  const f = await fixture(true);
  try {
    assert.match((await f.collect()).deferred[0]!.reason, /proposal/); assert.equal(f.calls, 0);
    const original = JSON.parse(await readFile(join(f.directory, 'supervisor.json'), 'utf8'));
    const expiresAt = original.journal.proposals[0].expiresAt;
    assert.equal((await f.collect(expiresAt + 1)).released.length, 2); assert.equal(f.points.size, 0);
  } finally { await f.close(); }
});

test('queued jobs and jobs with another binding cannot authorize cleanup', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'jobs.json'), original = await readFile(path, 'utf8'), jobs = JSON.parse(original);
    jobs.jobs.push({ command: { kind: 'propose', id: randomUUID() }, status: 'queued', createdAt: 0, updatedAt: 0 });
    await writeFile(path, JSON.stringify(jobs)); assert.match((await f.collect()).deferred[0]!.reason, /job/); assert.equal(f.calls, 0);
    jobs.binding.version = randomUUID(); await writeFile(path, JSON.stringify(jobs));
    await assert.rejects(f.collect(), /ownership mismatch/); assert.equal(f.calls, 0);
    await writeFile(path, original); assert.equal((await f.collect()).released.length, 1);
  } finally { await f.close(); }
});


for (const fail of [false, true]) test(`service shutdown joins archive maintenance (${fail ? 'failure' : 'success'})`, async () => {
  const f = await fixture(), service = await f.openCurrent();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const collect = f.runtime.collect;
  f.runtime.collect = async points => { entered(); await gate; if (fail) throw new Error('fixture cleanup failure'); return collect(points); };
  try {
    const work = service.collectArchived(f.data);
    const result = fail ? assert.rejects(work, /fixture cleanup failure/) : work;
    await started;
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(); await result; await closing;
    assert.equal(f.points.size, fail ? 1 : 0);
  } finally { release(); await service.close(); await f.close(); }
});
