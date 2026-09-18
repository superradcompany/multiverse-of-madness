import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileStore, ExecutableStore } from '@multiverse/gameplay-harness/node';
import type { Qualification, QualificationRequest, RevisionRules } from '@multiverse/gameplay-harness';
import { DoomSupervisor, decodeDoomSupervisor, type DoomSupervisorOptions, type SavedDoomSupervisor } from './doom-supervisor.ts';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { Session } from './session.ts';
import { SessionStore } from './persistence.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import type { DoomPolicy } from './doom-policy.ts';

const fallback = { decide: async () => structuredClone(decision) };
const accepted = async (request: QualificationRequest<DoomPolicy>): Promise<Qualification> => ({
  baseline: request.baseline.revision, candidate: request.candidate.revision, context: request.context, contract: request.contract,
  accepted: true, evidence: { fixture: true }, reason: 'Control-plane fixture, not gameplay quality',
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doom-supervisor-'));
  const disk = new JsonFileStore(join(root, 'supervisor.json'), decodeDoomSupervisor);
  const sessionStore = new SessionStore(join(root, 'session.json'));
  const hooks: { persist?: () => Promise<void>; adopt?: () => Promise<void>; qualify?: DoomSupervisorOptions['qualify'] } = {};
  const store = { load: () => disk.load(), save: async (value: SavedDoomSupervisor) => { await disk.save(value); await hooks.persist?.(); }, flush: () => disk.flush() };
  const models = new DoomLearningModels({ adapter: { id: 'doom-fixture', version: '1' }, builtinExecutor: { id: 'fixture-built-in', version: '1' },
    executables: new ExecutableStore(join(root, 'sources')), profile: 'game-aware', executable: () => fallback });
  const session = new Session(fallback, { threshold: .75, horizon: 35, branches: 2, paceMs: 0 });
  await session.initialize(new Runtime('root'));
  session.setPersistence(async value => { await sessionStore.save(value); await hooks.adopt?.(); });
  const initial = models.baseline(session.learningPolicy());
  const rules: RevisionRules = { contract: { id: 'fixture-only', version: '1' }, capabilities: ['prompts', 'skills', 'policy', 'executor', 'model'], maxLifetimeMs: 60000 };
  const options: DoomSupervisorOptions = { store, models, initial, rules, qualify: (request, signal) => (hooks.qualify ?? accepted)(request, signal) };
  let supervisor = await DoomSupervisor.open(options);
  const { revision: _, ...fields } = initial;
  const candidate = doomLearningArtifact({ ...fields, prompts: { plan: 'Prefer unseen areas.' }, policy: { ...fields.policy, decisionTicks: 14 } });
  const propose = (id = 'candidate') => supervisor.submit({ id, candidate, reason: 'Fixture proposal', expiresAt: Date.now() + 60000, expected: supervisor.origin() });
  return { root, disk, sessionStore, hooks, models, session, initial, candidate, options, propose,
    get supervisor() { return supervisor; },
    reopen: async () => {
      const saved = (await sessionStore.load())!;
      supervisor = await DoomSupervisor.open({ ...options, expectedBinding: saved.learning!.binding });
      const next = new Session(fallback, undefined, supervisor.binding);
      next.setPersistence(value => sessionStore.save(value));
      await next.restore(saved, async id => new Runtime(id, saved.worlds.find(world => world.view.id === id)!.view.state));
      supervisor.attach(next); return next;
    },
    cleanup: async () => { await supervisor.close().catch(() => {}); await rm(root, { recursive: true, force: true }); },
  };
}

test('server supervisor explicitly adopts a legacy session and owns one durable activation through reopen and rollback', async () => {
  const f = await fixture();
  try {
    assert.equal(f.session.checkpoint().version, 1);
    assert.throws(() => f.supervisor.origin(), /not attached/);
    assert.throws(() => f.supervisor.attach(f.session), /has not adopted/);
    f.session.queueObjective('Explore without taking damage');
    await f.supervisor.adopt(f.session);
    assert.equal(f.session.checkpoint().version, 2);
    const identity = f.supervisor.binding.identity;
    await f.propose(); await f.supervisor.evaluate('candidate');
    assert.equal((await f.supervisor.activate('candidate')).status, 'activated');
    assert.equal(f.session.snapshot().decisionIntervalTicks, 14);
    assert.equal(f.supervisor.snapshot().journal.active.epoch, 1);
    await f.sessionStore.save(f.session.checkpoint()); await f.supervisor.close();
    const session = await f.reopen();
    assert.deepEqual(f.supervisor.binding.identity, identity);
    assert.equal(session.snapshot().decisionIntervalTicks, 14);
    assert.equal(session.snapshot().pendingObjective, 'Explore without taking damage');
    assert.equal((await f.supervisor.rollback(f.initial.revision, 'Undo fixture change')).epoch, 2);
    assert.equal(session.snapshot().decisionIntervalTicks, f.initial.policy.decisionTicks);
    assert.equal((await f.disk.load())!.journal.active.epoch, 2);
  } finally { await f.cleanup(); }
});

test('observer overview keeps result summaries without copying historical gameplay evidence', async () => {
  const f = await fixture();
  try {
    await f.supervisor.adopt(f.session);
    f.hooks.qualify = async request => ({ ...await accepted(request), evidence: {
      meanGain: 3, gains: [{ gain: 3, gameplay: 'large historical trace' }], recordings: ['retained evidence'],
    } });
    await f.propose(); await f.supervisor.evaluate('candidate');
    const overview = f.supervisor.overview();
    assert.deepEqual(overview.journal.proposals[0]!.qualification!.evidence, { meanGain: 3, gains: [{ gain: 3 }] });
    assert.match(JSON.stringify(f.supervisor.snapshot()), /retained evidence/);
    overview.journal.proposals[0]!.reason = 'changed by caller';
    assert.notEqual(f.supervisor.overview().journal.proposals[0]!.reason, 'changed by caller');
    await f.sessionStore.save(f.session.checkpoint()); await f.supervisor.close(); await f.reopen();
    assert.deepEqual(f.supervisor.overview().journal.proposals[0]!.qualification!.evidence, { meanGain: 3, gains: [{ gain: 3 }] });
  } finally { await f.cleanup(); }
});

test('journal identity, rules, artifact contents and pre-generation user context are checked before use', async () => {
  const f = await fixture();
  try {
    await assert.rejects(DoomSupervisor.open({ ...f.options, expectedBinding: { id: 'doom-supervisor', version: '00000000-0000-4000-8000-000000000001' } }), /mismatched/);
    await assert.rejects(DoomSupervisor.open({ ...f.options, rules: { ...f.options.rules, contract: { id: 'new-evaluator', version: '1' } } }), /rules changed/);
    await f.supervisor.adopt(f.session);
    const expected = f.supervisor.origin(); f.session.queueObjective('A changed guide');
    await assert.rejects(f.supervisor.submit({ id: 'stale', candidate: f.candidate, reason: 'Old context', expiresAt: Date.now() + 60000, expected }), /stale/);
    const saved = (await f.disk.load())!;
    saved.journal.artifacts[0]!.prompts = { action: 'Altered without digest' }; await f.disk.save(saved);
    await assert.rejects(DoomSupervisor.open(f.options), /content mismatch/);
  } finally { await f.cleanup(); }
});

test('a lost activation acknowledgment fences the current host and authoritative reopen recovers the published epoch', async () => {
  const f = await fixture();
  try {
    await f.supervisor.adopt(f.session); await f.propose(); await f.supervisor.evaluate('candidate');
    f.hooks.persist = async () => { throw new Error('Lost acknowledgment'); };
    await assert.rejects(f.supervisor.activate('candidate'), /Lost acknowledgment/);
    assert.throws(() => f.supervisor.snapshot(), /publication failed/);
    assert.throws(() => f.supervisor.binding.current(), /publication failed/);
    assert.equal((await f.disk.load())!.journal.active.epoch, 1);
    f.hooks.persist = undefined; await f.supervisor.close();
    const restored = await f.reopen();
    assert.equal(restored.snapshot().decisionIntervalTicks, 14);
    assert.equal(f.supervisor.origin().activation.epoch, 1);
  } finally { await f.cleanup(); }
});

test('close cancels an active evaluation and waits for its cleanup before returning', async () => {
  const f = await fixture();
  const started = deferred(), aborted = deferred(), cleaned = deferred();
  try {
    f.hooks.qualify = async (request, signal) => {
      signal.addEventListener('abort', aborted.resolve, { once: true }); started.resolve();
      await aborted.promise; await cleaned.promise; return accepted(request);
    };
    await f.supervisor.adopt(f.session); await f.propose();
    const evaluation = f.supervisor.evaluate('candidate'); await started.promise;
    const firstClose = f.supervisor.close(); assert.equal(f.supervisor.close(), firstClose);
    let closed = false; const closing = firstClose.then(() => { closed = true; });
    await aborted.promise; assert.equal(closed, false);
    assert.throws(() => f.supervisor.origin(), /closed/);
    cleaned.resolve(); await closing;
    assert.equal((await evaluation).status, 'cancelled');
    assert.equal((await f.disk.load())!.journal.proposals[0]!.status, 'cancelled');
  } finally { cleaned.resolve(); aborted.resolve(); await f.cleanup(); }
});

test('restart retains interrupted evaluations and never auto-adopts or reruns them', async () => {
  const f = await fixture();
  try {
    await f.supervisor.adopt(f.session); await f.propose(); await f.supervisor.close();
    const saved = (await f.disk.load())!; saved.journal.proposals[0]!.status = 'evaluating'; await f.disk.save(saved);
    let calls = 0; f.hooks.qualify = async request => { calls++; return accepted(request); };
    await f.reopen();
    assert.equal(f.supervisor.snapshot().journal.proposals[0]!.status, 'interrupted'); assert.equal(calls, 0);
    await assert.rejects(f.supervisor.evaluate('candidate'), /already been evaluated/);
    assert.throws(() => f.supervisor.adopt(new Session(fallback)), /already has a session/);
  } finally { await f.cleanup(); }
});

test('adoption cannot attach two sessions concurrently and shutdown joins its persistence', async () => {
  const f = await fixture(); const entered = deferred(), release = deferred();
  try {
    f.hooks.adopt = async () => { entered.resolve(); await release.promise; };
    const adopting = f.supervisor.adopt(f.session); await entered.promise;
    assert.throws(() => f.supervisor.adopt(new Session(fallback)), /adoption in progress/);
    assert.throws(() => f.supervisor.attach(f.session), /adoption is in progress/);
    let closed = false; const closing = f.supervisor.close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    release.resolve(); await adopting; await closing;
    assert.equal((await f.sessionStore.load())!.version, 2);
  } finally { release.resolve(); await f.cleanup(); }
});
