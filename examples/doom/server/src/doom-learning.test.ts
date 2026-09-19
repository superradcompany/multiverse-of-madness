import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RevisionController, type LearningRevision, type RevisionJournal, type RevisionPorts } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { doomLearningBinding } from './doom-learning.ts';
import { parseDoomLearningPolicy, type DoomPolicy } from './doom-policy.ts';
import { Session, type SessionCheckpoint } from './session.ts';
import { SessionStore } from './persistence.ts';
import { Recordings } from './recordings.ts';
import { defaultDoomOutcomeWeights } from './doom-outcome.ts';
import { doomSurvivalProgress } from './doom-revision-evaluation.ts';
import { Runtime, decision, initial } from '../test-support/fixture-runtime.ts';
import type { GameState, Step } from '../../contracts/src/game.ts';
import { defaultDoomExecutionPolicy } from './doom-execution-policy.ts';
import { defaultDoomMotorPolicy } from './doom-motor-policy.ts';
import { navigateDoomInputs } from './doom-navigation.ts';
import { DoomMap } from './doom-geometry.ts';

const options = { threshold: .75, horizon: 7, branches: 2, paceMs: 0 };
const fallback = { decide: async () => structuredClone(decision) };
const main = (session: Session) => session.snapshot().worlds.find(world => world.id === session.snapshot().mainId)!;
async function fixture(adopt = false, runtime: Runtime = new Runtime('root')) {
  const root = await mkdtemp(join(tmpdir(), 'doom-learning-'));
  const journal = new JsonFileStore(join(root, 'supervisor.json'), value => value as RevisionJournal<DoomPolicy>);
  const store = new SessionStore(join(root, 'session.json'));
  const recordings = new Recordings(join(root, 'recordings')); await recordings.open();
  let session: Session | undefined;
  const policy = new Session(fallback, options).learningPolicy(), identity = contentRevision('doom-supervisor-test', { root });
  const make = (tag: string, policy: DoomPolicy): LearningRevision<DoomPolicy> => {
    const fields = { policy, adapter: { id: 'fixture-doom-adapter', version: '1' }, model: { id: 'fixture-model', version: tag },
      executor: { id: 'fixture-executor', version: tag }, prompts: { tactical: tag }, skills: [{ id: 'test-skill', instructions: tag }] };
    return { ...fields, revision: contentRevision('doom-learning-test', fields) };
  };
  const baseline = make('baseline', policy), candidate = make('candidate', { ...policy, decisionTicks: 14, trialTicks: 21, memory: { ...policy.memory, perDecision: 3 } });
  const hooks: { model?: () => Promise<void>; persist?: () => Promise<void>; decision?: typeof decision } = {};
  const seen: Array<{ tag: string; guide: string; ticks: number | undefined; skills: string[]; trialTicks: number | undefined }> = [];
  const ports: RevisionPorts<DoomPolicy> = {
    context: () => session?.supervisorContext() ?? contentRevision('unattached', {}),
    boundary: work => session!.revisionBoundary(work),
    persist: async value => { await journal.save(value); await hooks.persist?.(); },
    verify: async artifact => { const { revision, ...data } = artifact; assert.deepEqual(revision, contentRevision(revision.id, data));
      assert.deepEqual(artifact.adapter, baseline.adapter); parseDoomLearningPolicy(artifact.policy); },
    compatible: async (_before, after) => session!.validateLearningRevision(after),
    // This fixture qualifies session wiring, never game strength or real VM behavior.
    qualify: async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision,
      context: request.context, contract: request.contract, accepted: true, reason: 'Controlled wiring test', evidence: { fixture: true } }),
  };
  const rules = { contract: { id: 'fixture-evaluator', version: '1' }, capabilities: ['policy', 'prompts', 'skills', 'executor', 'model'] as Array<'policy' | 'prompts' | 'skills' | 'executor' | 'model'>, maxLifetimeMs: 60000 };
  let controller = await RevisionController.create(baseline, rules, ports);
  const binding = () => doomLearningBinding(controller, identity, artifact => ({ decide: async (_state, guide, _history, signal, _experience, ticks, context) => {
    await hooks.model?.(); signal.throwIfAborted();
    seen.push({ tag: artifact.prompts.tactical!, guide, ticks, trialTicks: context?.policy?.trialTicks, skills: artifact.skills.map(skill => skill.instructions) });
    return { ...structuredClone(hooks.decision ?? decision), model: artifact.model.version };
  } }));
  const points = new Map<string, GameState>();
  const attach = (current: Session) => {
    current.setPersistence(value => store.save(value));
    current.setRecorder((world, frame) => recordings.record(world, frame));
    current.setMainRecorder(id => recordings.retainPath(id));
    current.setCheckpointAdapter({ capture: async (runtime, reference) => { points.set(reference, await runtime.state()); },
      restore: async (reference, id) => new Runtime(id, structuredClone(points.get(reference)!)), remove: async reference => { points.delete(reference); } });
  };
  session = new Session(fallback, options, adopt ? undefined : binding()); attach(session);
  await session.initialize(runtime); await store.save(session.checkpoint());
  const step = async () => { session!.step(); await session!.idle(); assert.equal(session!.snapshot().error, undefined); };
  const promote = async () => { await session!.promote(session!.checkpoint().experiments[0]!.id); };
  const reopen = async (saved?: SessionCheckpoint) => {
    const checkpoint = saved ?? (await store.load())!;
    session = undefined; controller = await RevisionController.restore((await journal.load())!, rules, ports);
    const next = new Session(fallback, options, binding()); attach(next);
    await next.restore(checkpoint, async (id, identity) => { const runtime = new Runtime(id, checkpoint.worlds.find(world => world.view.id === id)!.view.state); assert.equal(identity, runtime.identity); return runtime; });
    session = next;
  };
  return { root, store, recordings, baseline, candidate, binding, hooks, seen, get session() { return session!; }, get controller() { return controller; },
    step, promote, reopen, save: () => store.save(session!.checkpoint()),
    propose: async (id = 'candidate', artifact = candidate) => { await controller.submit({ id, candidate: artifact, reason: 'Controlled revision change', expiresAt: Date.now() + 60000 }); await controller.evaluate(id); },
    cleanup: async () => { await recordings.flush(); await rm(root, { recursive: true, force: true }); } };
}

test('Doom pins learning provenance in forks, checkpoints and replay; restart and world rollback use the active controller', async () => {
  const f = await fixture();
  try {
    await f.step(); await f.promote(); await f.session.saveRecoveryCheckpoint();
    const point = f.session.snapshot().recovery!.checkpoints[0]!;
    f.session.setTrialDuration(35); f.session.queueObjective('Stay alive and explore'); await f.save();
    await f.propose();
    const before = await readFile(join(f.root, 'session.json'), 'utf8');
    await f.controller.activate('candidate');
    assert.equal(await readFile(join(f.root, 'session.json'), 'utf8'), before, 'no second active-pointer publication');
    assert.equal(f.session.snapshot().trialDurationTicks, 35, 'user duration wins');
    assert.equal(f.session.snapshot().decisionIntervalTicks, 14, 'other policy changes take effect');
    await f.reopen(); await f.step();
    for (const trial of f.session.checkpoint().experiments) {
      const world = f.session.snapshot().worlds.find(world => world.id === trial.id)!;
      assert.equal(world.learning?.activation.epoch, 1); assert.deepEqual(world.learning?.executor, f.candidate.executor);
      const first = await f.recordings.get(world.id, 0); assert.deepEqual(first.world.learning, world.learning);
    }
    assert.ok(f.seen.some(value => value.tag === 'candidate' && value.guide === 'Stay alive and explore' && value.skills.includes('candidate') && value.trialTicks === 35));
    await f.promote(); await f.session.rollback(point.id);
    assert.equal(main(f.session).learning?.activation.epoch, 0);
    await f.step(); assert.equal(f.session.snapshot().decision?.learning?.activation.epoch, 1);
    await f.promote(); await f.controller.rollback(f.baseline.revision, 'Restore prior learning code');
    await f.reopen(); await f.step(); assert.equal(f.session.snapshot().decision?.learning?.activation.epoch, 2);
    assert.deepEqual(f.session.snapshot().decision?.learning?.executor, f.baseline.executor);
    assert.equal(f.session.snapshot().trialDurationTicks, 35);
    assert.equal(f.session.checkpoint().version, 2);
  } finally { await f.cleanup(); }
});

test('Doom refuses activation during decisions and unresolved trials, including stale restart snapshots', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.propose(); f.hooks.model = async () => { entered(); await gate; };
    const step = f.step(); await waiting;
    await assert.rejects(f.controller.activate('candidate'), /Pause/);
    f.hooks.model = undefined; release(); await step;
    await assert.rejects(f.controller.activate('candidate'), /Resolve the active Doom comparison/);
    const oldBatch = f.session.checkpoint();
    await f.reopen(); assert.ok(f.session.checkpoint().experiments.length > 0);
    await f.promote(); await f.controller.activate('candidate');
    await assert.rejects(f.reopen(oldBatch), /different active learning revision/);
  } finally { release?.(); await f.cleanup(); }
});

test('Doom fences guide and control edits through publication and reopens authoritative state after a lost acknowledgment', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.propose(); f.hooks.persist = async () => { entered(); await gate; };
    const activation = f.controller.activate('candidate'); await waiting;
    assert.throws(() => f.session.queueObjective('changed'), /publication/);
    assert.throws(() => f.session.setForkThreshold(.1), /publication/);
    assert.throws(() => f.session.configureMemory(16, 2), /publication/);
    assert.throws(() => f.session.clearExperience(), /publication/);
    assert.throws(() => f.session.step(), /Pause/);
    release(); await activation;
    f.hooks.persist = async () => { throw new Error('lost publication acknowledgment'); };
    await assert.rejects(f.controller.rollback(f.baseline.revision, 'rollback'), /lost publication/);
    const calls = f.seen.length; f.session.step(); await f.session.idle();
    assert.equal(f.seen.length, calls); assert.match(f.session.snapshot().error!, /reopen|persist|publication/i);
    f.hooks.persist = undefined; await f.reopen(); await f.step();
    assert.equal(f.session.snapshot().decision?.learning?.activation.epoch, 2);
  } finally { release?.(); await f.cleanup(); }
});

test('supervised Doom restore refuses missing bindings and forged artifact provenance before reconnecting', async () => {
  const f = await fixture();
  try {
    await f.step(); const saved = f.session.checkpoint();
    await assert.rejects(new Session(fallback, options).restore(saved, async () => assert.fail('must not reconnect')), /original learning binding/);
    const corrupt = structuredClone(saved); corrupt.worlds.find(world => world.view.learning)!.view.learning!.executor.version = 'forged';
    await assert.rejects(new Session(fallback, options, f.binding()).restore(corrupt, async () => assert.fail('must not reconnect')), /provenance/);
    const legacy = structuredClone(saved); legacy.version = 1;
    await assert.rejects(new Session(fallback, options, f.binding()).restore(legacy, async () => assert.fail('must not reconnect')), /legacy/);
  } finally { await f.cleanup(); }
});

test('explicit adoption preserves legacy game state and controls, while changed guides stale old proposals', async () => {
  const f = await fixture(true);
  try {
    const before = f.session.checkpoint(); assert.equal(before.version, 1);
    await f.session.adoptLearning(f.binding());
    const saved = (await f.store.load())!; assert.equal(saved.version, 2);
    assert.deepEqual(saved.worlds, JSON.parse(JSON.stringify(before.worlds))); assert.deepEqual(saved.view.objective, before.view.objective);
    await f.propose(); f.session.queueObjective('Collect supplies first');
    assert.equal((await f.controller.activate('candidate')).status, 'stale');
    assert.equal(f.controller.active.epoch, 0);
    await f.save(); await f.reopen(); await f.step();
    assert.equal(f.session.snapshot().decision?.learning?.activation.epoch, 0);
    assert.ok(f.seen.every(value => value.guide === 'Collect supplies first'));
  } finally { await f.cleanup(); }
});

test('the actual pre-extraction reader still loads its version-1 fixture and cleanly refuses a new supervised session', async () => {
  const source = await readFile(new URL('../fixtures/session-fd777f7/persistence.ts.source', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), '9f4d165d58ad9e1187ff6ae759d79782ee8f0767bfbd549b63bd4c5e9ce32567');
  // Trusted historical repository source, compiled without changing its reader behavior.
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const { SessionStore: LegacyStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`) as {
    SessionStore: new (path: string) => { load(): Promise<{ version: number }> };
  };
  const historical = new URL('../fixtures/session-fd777f7/session.json', import.meta.url);
  assert.equal((await new LegacyStore(fileURLToPath(historical)).load()).version, 1);
  const f = await fixture();
  try {
    assert.equal((await f.store.load())!.version, 2);
    await assert.rejects(new LegacyStore(join(f.root, 'session.json')).load(), /Unsupported or invalid session file/);
  } finally { await f.cleanup(); }
});

test('a lost adoption acknowledgment never permits a legacy fallback; restart reads the version-2 write', async () => {
  const f = await fixture(true);
  try {
    f.session.setPersistence(async value => { await f.store.save(value); throw undefined; });
    await assert.rejects(f.session.adoptLearning(f.binding()), /reopen authoritative storage/);
    assert.throws(() => f.session.step(), /reopen authoritative storage/);
    assert.equal((await f.store.load())!.version, 2);
    await f.reopen(); await f.step();
    assert.equal(f.session.snapshot().decision?.learning?.activation.epoch, 0);
  } finally { await f.cleanup(); }
});


test('supervised search weights change future selection, survive restore, and cannot change independent scoring', async () => {
  class Tradeoff extends Runtime {
    override async branch(ids: string[]) {
      return ids.map((id, index) => new class extends Runtime {
        override async state() {
          const state = await super.state();
          return index === 0 && state.tick > initial.tick ? { ...state, health: 80, kills: 1 } : state;
        }
      }(id));
    }
  }
  const f = await fixture(false, new Tradeoff('root'));
  try {
    const weights = structuredClone(defaultDoomOutcomeWeights);
    weights.exploration.health = 1; weights.exploration.kills = 200;
    const { revision: _, ...fields } = f.baseline;
    const candidate = { ...fields, policy: { ...fields.policy, outcomeWeights: weights } };
    await f.propose('shaping', { ...candidate, revision: contentRevision('doom-learning-test', candidate) });
    await f.controller.activate('shaping'); await f.step();
    const view = f.session.snapshot(), risky = view.worlds.find(world => world.role === 'experiment' && world.state.health === 80)!;
    assert.ok(risky); assert.equal(view.comparison!.bestId, risky.id); assert.equal(risky.score, 180);
    const saved = f.session.checkpoint();
    const scoring = saved.policies!.find(entry => entry.revision.version === saved.view.decision!.policyRevision!.version)!;
    assert.deepEqual(scoring.policy.values.outcomeWeights, weights);
    await f.save(); await f.reopen(); assert.equal(f.session.snapshot().comparison!.bestId, risky.id);
    await f.step(); const final = main(f.session).state;
    assert.equal(final.health, 80); assert.equal(final.kills, 1);
    const evidence = { initial, final, session: f.session.snapshot(), decisions: [] };
    const independent = doomSurvivalProgress(evidence);
    assert.equal(independent.health, 80); assert.equal(independent.kills, 1); assert.equal(independent.score, 10180);
    assert.notEqual(independent.score, risky.score);
    const tampered = structuredClone(saved);
    (tampered.policies!.find(entry => entry.revision.version === scoring.revision.version)!.policy.values.outcomeWeights!.exploration as { kills: number }).kills = 999;
    await assert.rejects(f.reopen(tampered), /does not match its revision/);
  } finally { await f.cleanup(); }
});

test('supervised execution policy drives session inputs and retains historical provenance on reconnect', async () => {
  const commands: Step[] = [];
  class ObservedRuntime extends Runtime {
    override async step(command: Step) { commands.push(structuredClone(command)); return super.step(command); }
    override async branch(ids: string[]) { const state = await this.state(); return ids.map(id => new ObservedRuntime(id, structuredClone(state))); }
  }
  const f = await fixture(false, new ObservedRuntime('root'));
  try {
    f.hooks.decision = { ...decision, confidence: 1, plans: { selected: 'interact', candidates: [{ id: 'interact', label: 'try switch', probability: 1,
      steps: [{ kind: 'use', label: 'press and release', target: { kind: 'point', x: 32, y: 0, z: 0 }, maxTicks: 140 }] }] } };
    const execution = { ...defaultDoomExecutionPolicy, usePulseTicks: 2 };
    const { revision: _, ...fields } = f.baseline;
    const candidate = { ...fields, policy: { ...fields.policy, execution } };
    await f.propose('execution', { ...candidate, revision: contentRevision('doom-learning-test', candidate) });
    await f.controller.activate('execution'); await f.step();
    assert.deepEqual(commands.map(command => command.inputs), [['use'], [], ['use'], [], ['use'], [], ['use']]);
    await f.promote();
    const saved = f.session.checkpoint(), reference = main(f.session).policyRevision!;
    assert.deepEqual(saved.policies!.find(policy => policy.revision.version === reference.version)!.policy.values.execution, execution);
    await f.save(); await f.reopen();
    assert.deepEqual(f.session.learningPolicy().execution, execution);
    assert.deepEqual(main(f.session).policyRevision, reference);
    await f.controller.rollback(f.baseline.revision, 'Restore the original execution rules');
    assert.equal(f.session.learningPolicy().execution, undefined);
    assert.deepEqual(f.session.checkpoint().policies!.find(policy => policy.revision.version === reference.version)!.policy.values.execution, execution);
    const changed = structuredClone(saved);
    (changed.policies!.find(policy => policy.revision.version === reference.version)!.policy.values.execution! as { usePulseTicks: number }).usePulseTicks = 3;
    await assert.rejects(f.reopen(changed), /does not match its revision/);
  } finally { await f.cleanup(); }
});

test('a supervisor motor revision reaches forked controls and survives reconnect and rollback', async () => {
  const commands = new Map<string, Step[]>();
  class Stationary extends Runtime {
    override async step(command: Step) { const history = commands.get(this.id) ?? []; history.push(structuredClone(command)); commands.set(this.id, history); return super.step(command); }
    override async branch(ids: string[]) { const state = await this.state(); return ids.map(id => new Stationary(id, structuredClone(state))); }
  }
  const f = await fixture(false, new Stationary('root'));
  try {
    const motor = { ...defaultDoomMotorPolicy, stalledTicks: 2 };
    const { revision: _, ...fields } = f.baseline;
    const candidate = { ...fields, policy: { ...fields.policy, motor } };
    await f.propose('motor', { ...candidate, revision: contentRevision('doom-learning-test', candidate) });
    await f.controller.activate('motor');
    const controlled = new Set<number>();
    f.session.setControls(async (state, inputs, navigation, policy) => {
      controlled.add(policy!.motor!.stalledTicks);
      return navigateDoomInputs(state, inputs, new DoomMap([]), navigation, policy);
    });
    const move = { id: 'move', label: 'move', probability: 1, steps: [{ kind: 'move' as const, label: 'advance', target: { kind: 'point' as const, x: 128, y: 0, z: 0 }, maxTicks: 140 }] };
    f.hooks.decision = { ...decision, confidence: 1, plans: { selected: move.id, candidates: [move] } };
    await f.step();
    assert.deepEqual([...controlled], [2]);
    const history = commands.get(f.session.checkpoint().experiments[0]!.id)!;
    assert.ok(history[0]!.inputs.includes('forward')); assert.ok(history[1]!.inputs.includes('forward'));
    assert.deepEqual(history[2]!.inputs, ['left']);
    await f.promote(); const reference = main(f.session).policyRevision!;
    await f.save(); await f.reopen();
    assert.deepEqual(f.session.learningPolicy().motor, motor);
    assert.deepEqual(main(f.session).policyRevision, reference);
    await f.controller.rollback(f.baseline.revision, 'Return to the prior motor preferences');
    assert.equal(f.session.learningPolicy().motor, undefined);
    assert.deepEqual(f.session.checkpoint().policies!.find(record => record.revision.version === reference.version)!.policy.values.motor, motor);
  } finally { await f.cleanup(); }
});

test('supervisor breadth changes within the user cap, survives restart, and governs actual forks', async () => {
  const f = await fixture();
  try {
    f.session.setMaxFutures(6);
    const revise = (breadth: number) => {
      const { revision: _old, ...fields } = f.baseline;
      const next = { ...fields, policy: { ...fields.policy, breadth } };
      return { ...next, revision: contentRevision('doom-learning-test', next) };
    };
    await f.propose('four', revise(4)); await f.controller.activate('four');
    assert.equal(f.session.snapshot().maxFutures, 6);
    assert.equal(f.session.snapshot().effectiveFutures, 4);
    await f.step(); assert.equal(f.session.checkpoint().experiments.length, 4); await f.promote();
    await f.propose('ten', revise(10)); await f.controller.activate('ten');
    assert.equal(f.session.snapshot().maxFutures, 6);
    assert.equal(f.session.snapshot().effectiveFutures, 6);
    await f.save(); await f.reopen();
    assert.equal(f.session.snapshot().maxFutures, 6); assert.equal(f.session.snapshot().effectiveFutures, 6);
    await f.step(); assert.equal(f.session.checkpoint().experiments.length, 6); await f.promote();
    await f.propose('two', revise(2)); await f.controller.activate('two');
    assert.equal(f.session.snapshot().maxFutures, 6); assert.equal(f.session.snapshot().effectiveFutures, 2);
    await f.step(); assert.equal(f.session.checkpoint().experiments.length, 2);
  } finally { await f.cleanup(); }
});
