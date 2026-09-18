import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RevisionController, canonicalJson, type LearningRevision, type RevisionJournal, type RevisionPorts } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { defaultChessPolicy, parseChessPolicy } from './policy.ts';
import { chessLearningBinding, type ChessDecisionModel } from './revisions.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessSession } from './session.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';

const main = (saved: ChessSessionCheckpoint) => saved.worlds.find(world => world.meta.id === saved.mainId)!;
async function setup(overrides: Partial<ChessPolicy> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chess-revision-'));
  const adapter = new ChessAdapter(), fixture = new ChessFixtureModel(), policy = { ...defaultChessPolicy, threshold: 0, ...overrides };
  const identity = contentRevision('chess-supervisor-journal', { root });
  const make = (tag: string, nextPolicy: ChessPolicy): LearningRevision<ChessPolicy> => {
    const data = { adapter: adapter.version, model: fixture.version, policy: nextPolicy, executor: { id: 'test-source', version: tag }, prompts: { opening: tag === 'improved' ? 'e4' : 'a3' }, skills: [{ id: 'opening', instructions: tag }] };
    return { ...data, revision: contentRevision('chess-learning-test', data) };
  };
  const baseline = make('baseline', policy), candidate = make('improved', { ...policy, checkpointEvery: 1, checkpointLimit: 2, memoryCapacity: 8 });
  const rules = { contract: { id: 'unit-wiring-evaluator', version: '1' }, capabilities: ['policy', 'prompts', 'skills', 'executor'] as Array<'policy' | 'prompts' | 'skills' | 'executor'>, maxLifetimeMs: 60000 };
  const store = new JsonFileStore(join(root, 'supervisor.json'), value => value as RevisionJournal<ChessPolicy>);
  let session: ChessSession | undefined;
  const hooks: { model?: () => Promise<void>; publication?: () => Promise<void> } = {};
  const seen: Array<{ revision: string; executor: string; skills: string[] }> = [];
  const ports: RevisionPorts<ChessPolicy> = {
    context: () => session?.supervisorContext() ?? contentRevision('chess-user-context', { objective: 'win by checkmate', profile: policy, adapter: adapter.version }),
    boundary: work => { if (!session) throw new Error('Session not attached'); return session.revisionBoundary(work); },
    persist: async snapshot => { await store.save(snapshot); await hooks.publication?.(); },
    verify: async artifact => {
      const { revision, ...data } = artifact; assert.deepEqual(revision, contentRevision(revision.id, data));
      assert.deepEqual(artifact.adapter, adapter.version); assert.deepEqual(artifact.model, fixture.version); parseChessPolicy(artifact.policy);
    },
    compatible: async (before, after) => { assert.deepEqual(before.adapter, after.adapter); },
    // This test injects an accepted qualification; it proves session wiring, not gameplay improvement.
    qualify: async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision, contract: request.contract,
      context: request.context, accepted: true, reason: 'Unit-test qualification fixture', evidence: { fixture: true } }),
  };
  let controller = await RevisionController.create(baseline, rules, ports);
  const model = (artifact: LearningRevision<ChessPolicy>): ChessDecisionModel => ({ version: artifact.model, decide: async (request, signal) => {
    await hooks.model?.(); signal.throwIfAborted();
    assert.deepEqual(request.revision, artifact.revision);
    seen.push({ revision: artifact.revision.version, executor: artifact.executor.version, skills: artifact.skills.map(skill => skill.instructions) });
    const preferred = request.candidates.find(plan => plan.id === artifact.prompts.opening);
    if (!preferred) return fixture.decide(request, signal);
    return { selected: preferred.id, confidence: .4, usage: { calls: 0 }, preferences: request.candidates.map(plan => ({ id: plan.id, probability: plan.id === preferred.id ? 1 : 0 })) };
  } });
  const provider = () => new ChessRuntimeStore(join(root, 'runtime'));
  session = await ChessSession.create(root, provider(), adapter, fixture, policy, chessLearningBinding(controller, identity, model));
  return { root, baseline, candidate, seen, hooks, get session() { return session!; }, get controller() { return controller; },
    propose: async () => { await controller.submit({ id: 'candidate', candidate, reason: 'Test a revision boundary', expiresAt: Date.now() + 60000 }); await controller.evaluate('candidate'); },
    reopen: async () => {
      session = undefined;
      controller = await RevisionController.restore((await store.load())!, rules, ports);
      session = await ChessSession.restore(root, provider(), adapter, fixture, chessLearningBinding(controller, identity, model));
      return session;
    },
    remove: () => rm(root, { recursive: true, force: true }) };
}

test('active revisions survive reopen and world rollback while decisions, checkpoints and replay retain historical provenance', async () => {
  const f = await setup();
  try {
    await f.session.step(); await f.session.step();
    const initial = f.session.snapshot().points.points[0]!, old = await readFile(join(f.root, 'session.json'), 'utf8');
    assert.equal(main(f.session.snapshot()).state.ply, 2);
    await f.propose(); await f.controller.activate('candidate');
    assert.equal(await readFile(join(f.root, 'session.json'), 'utf8'), old); // No second active pointer publication.
    await f.reopen(); await f.session.step();
    const played = main(f.session.snapshot());
    assert.equal(played.state.moves.at(-1), 'e4'); assert.equal(played.provenance.learning?.epoch, 1);
    assert.deepEqual(played.provenance.executor, f.candidate.executor);
    assert.equal((await f.session.replayFrame(1)).world.provenance.learning?.epoch, 0);
    assert.equal((await f.session.replayFrame(3)).world.provenance.learning?.epoch, 1);
    const oldPoint = f.session.snapshot().points.points.findLast(item => item.data.provenance.learning?.epoch === 0)!;
    const point = await f.session.checkpoint();
    assert.equal(f.session.snapshot().points.points.find(item => item.id === point)!.data.provenance.learning?.epoch, 1);
    // World rollback restores old provenance; subsequent execution uses the separately active revision.
    await f.session.rollback(oldPoint.id); assert.equal(main(f.session.snapshot()).state.ply, 2);
    assert.equal(main(f.session.snapshot()).provenance.learning?.epoch, 0);
    await f.session.step(); assert.equal(main(f.session.snapshot()).provenance.learning?.epoch, 1);
    await f.controller.rollback(f.baseline.revision, 'Return to previous learning system');
    await f.reopen(); await f.session.step();
    assert.equal(main(f.session.snapshot()).provenance.learning?.epoch, 2);
    assert.deepEqual(main(f.session.snapshot()).provenance.executor, f.baseline.executor);
    assert.equal(f.controller.snapshot().history.length, 2);
    assert.ok(f.seen.some(item => item.executor === 'improved' && item.skills.includes('improved')));
    assert.ok(f.session.snapshot().attempts.plies > main(f.session.snapshot()).state.ply - 1);
    assert.equal(initial.data.provenance.learning?.epoch, 0);
  } finally { await f.remove(); }
});

test('activation refuses an in-flight decision and an unresolved batch; every sibling keeps one revision', async () => {
  const f = await setup({ threshold: 1 });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.propose(); f.hooks.model = async () => { entered(); await wait; };
    const step = f.session.step(); await ready;
    await assert.rejects(f.controller.activate('candidate'), /already in progress/);
    f.hooks.model = undefined; release(); await step;
    const compared = f.session.snapshot(); assert.ok(compared.batch?.complete);
    await assert.rejects(f.controller.activate('candidate'), /Resolve the active comparison/);
    for (const id of compared.batch.ids) assert.equal(compared.worlds.find(world => world.meta.id === id)!.provenance.learning?.epoch, 0);
    await f.reopen(); await f.session.step(); // Promote the old batch before publication.
    await f.controller.activate('candidate'); await f.session.step();
    for (const id of f.session.snapshot().batch!.ids) assert.equal(f.session.snapshot().worlds.find(world => world.meta.id === id)!.provenance.learning?.epoch, 1);
  } finally { release?.(); await f.remove(); }
});

test('guide edits are fenced during activation and lost publication acknowledgment requires authoritative reopen', async () => {
  const f = await setup();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.propose();
    f.hooks.publication = async () => { entered(); await wait; throw new Error('acknowledgment lost'); };
    const activating = assert.rejects(f.controller.activate('candidate'), /acknowledgment lost/); await ready;
    await assert.rejects(f.session.guide('different objective'), /publication is in progress/);
    await assert.rejects(f.session.step(), /already in progress/);
    assert.equal(f.controller.active.epoch, 0);
    release(); await activating;
    await assert.rejects(f.session.step(), /reopen from authoritative storage/);
    f.hooks.publication = undefined;
    await f.reopen(); assert.equal(f.controller.active.epoch, 1);
    await f.session.step(); assert.equal(main(f.session.snapshot()).state.moves[0], 'e4');
    assert.equal(main(f.session.snapshot()).provenance.learning?.epoch, 1);
  } finally { release?.(); await f.remove(); }
});

test('saved learning provenance cannot be replaced by an inactive proposal or an unrelated executor', async () => {
  const f = await setup();
  try {
    const original = f.session.snapshot(), saved = structuredClone(original);
    main(saved).provenance.executor = { id: 'other', version: '1' };
    await writeFile(join(f.root, 'session.json'), JSON.stringify(saved));
    await assert.rejects(f.reopen(), /provenance does not match/);
    await f.propose();
    main(original).provenance.learning = { revision: f.candidate.revision, epoch: 1 };
    await writeFile(join(f.root, 'session.json'), JSON.stringify(original));
    await assert.rejects(f.reopen(), /Unknown chess learning activation/);
    assert.equal(canonicalJson(f.controller.active.revision), canonicalJson(f.baseline.revision));
  } finally { await f.remove(); }
});


test('changing the user guide invalidates an otherwise qualified session revision', async () => {
  const f = await setup();
  try {
    await f.propose(); await f.session.guide('keep all pawns alive');
    assert.equal((await f.controller.activate('candidate')).status, 'stale');
    assert.equal(f.controller.active.epoch, 0);
    await f.session.step(); assert.equal(main(f.session.snapshot()).provenance.learning?.epoch, 0);
  } finally { await f.remove(); }
});
