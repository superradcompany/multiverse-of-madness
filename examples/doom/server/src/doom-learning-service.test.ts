import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { DoomLearningService, type DoomLearningServiceOptions } from './doom-learning-service.ts';
import { Session } from './session.ts';
import { SessionStore } from './persistence.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import type { GameState } from '../../contracts/src/game.ts';
import type { DoomProposalEvidence } from './doom-supervisor-proposal.ts';

async function fixture(practice = false) {
  const directory = await mkdtemp(join(tmpdir(), 'doom-learning-service-'));
  const buildData = { node: process.version, files: {} };
  const worlds = new Map<string, Runtime>(), points = new Map<string, GameState>();
  let providerCalls = 0, modelCalls = 0;
  const requests: DoomProposalEvidence[] = [];
  const options: DoomLearningServiceOptions = { backgroundLearning: false, bootstrapPlanner: false,
    directory, profile: 'game-aware', build: { ...buildData, revision: contentRevision('fixture-build', buildData) },
    image: 'docker.io/library/node@sha256:' + 'a'.repeat(64),
    modelClient: { systemOne: async (body: any) => {
      modelCalls++;
      return { model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
        const ids = Object.keys(question.criteria), choice = ids.includes('wait') ? 'wait' : ids[0];
        return [key, { choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
      })) };
    } } as unknown as Pick<TypeSafeClient, 'systemOne'>,
    proposalProvider: async record => ({ version: { id: 'fixture-provider', version: '1' }, propose: async request => {
      providerCalls++;
      requests.push(structuredClone(request.evidence));
      const menu = request.evidence.training;
      const response = { draft: { kind: 'guidance', reason: 'Measure before repeating movement', prompts: { action: 'Use measured progress.' },
        ...(practice && menu ? { training: { catalog: menu.catalog, scenarioIds: [menu.scenarios[0]!.id], reason: 'Check the opening before the saved incident' } } : {}) },
        receipt: { id: request.id, provider: { id: 'fixture-provider', version: '1' }, startedAt: Date.now(), elapsedMs: 1,
          inputBytes: 100, outputBytes: 100, requestedModel: 'fixture', servingModels: ['fixture'], status: 'complete' as const,
          usage: { inputTokens: 12, outputTokens: 4, costMicros: 123 } } };
      await record(response); return response;
    } }),
    runtime: {
      create: async id => { const world = new Runtime(id); worlds.set(id, world); return world; },
      destroy: async (id, identity) => { const world = worlds.get(id); if (!world) return; assert.ok(!identity || identity === world.identity); await world.destroy(); worlds.delete(id); },
      capture: async (world, ref) => { points.set(ref, await world.state()); },
      restore: async (ref, id) => { const world = Object.assign(new Runtime(id, structuredClone(points.get(ref)!)), { parent: 'physical-' + ref }); worlds.set(id, world); return world; },
      parentSnapshot: async world => (world as Runtime & { parent?: string }).parent,
      snapshotIdentity: async ref => points.has(ref) ? 'physical-' + ref : undefined,
      collect: async requested => { for (const point of requested) points.delete(point.reference); return []; },
    },
  };
  const source = new Runtime('live-root'), store = new SessionStore(join(directory, 'session.json'));
  let session = new Session({ decide: async () => decision }, { threshold: 0, horizon: 7, branches: 2, paceMs: 0 });
  await session.initialize(source); session.setPlanningMode('actions'); session.queueObjective('Preserve health and reach the exit');
  session.setCheckpointAdapter({ capture: options.runtime!.capture, restore: options.runtime!.restore, remove: async ref => { points.delete(ref); } });
  session.setPersistence(saved => store.save(saved)); await store.save(session.checkpoint());
  let service = await DoomLearningService.open(options); await service.attach(session);
  return { directory, options, source, worlds, points, store, requests, get session() { return session; }, get service() { return service; },
    get providerCalls() { return providerCalls; }, get modelCalls() { return modelCalls; },
    reopen: async () => {
      await service.close(); const saved = (await store.load())!;
      service = await DoomLearningService.open(options, saved.learning?.binding);
      session = new Session({ decide: async () => decision }, undefined, saved.learning ? service.binding : undefined);
      await session.restore(saved, async (id, identity) => { assert.equal(id, source.id); assert.equal(identity, source.identity); return source; });
      session.setCheckpointAdapter({ capture: options.runtime!.capture, restore: options.runtime!.restore, remove: async ref => { points.delete(ref); } });
      session.setPersistence(value => store.save(value)); await service.attach(session);
    },
    cleanup: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
async function settled(service: DoomLearningService) {
  const deadline = Date.now() + 60000;
  while (service.view().busy) { assert.ok(Date.now() < deadline, 'learning job did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
  return service.view();
}

test('checkpoint preparation is visible before generation and finishes after paused promotion', async () => {
  const f = await fixture();
  try {
    await f.service.enable();
    f.session.step(); await f.session.idle();
    assert.ok(f.session.snapshot().worlds.some(world => world.role === 'experiment'));
    const id = randomUUID();
    await f.service.start({ kind: 'propose', id, provider: 'codex', proposalKind: 'guidance' });
    const deadline = Date.now() + 1000;
    while (!f.service.view().jobs.find(job => job.id === id)?.preparingCheckpoint) {
      assert.ok(Date.now() < deadline, 'checkpoint preparation was not visible');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(f.providerCalls, 0);
    f.session.step(); await f.session.idle();
    const done = await settled(f.service);
    assert.equal(done.jobs.find(job => job.id === id)?.status, 'complete');
    assert.equal(done.jobs.find(job => job.id === id)?.preparingCheckpoint, undefined);
    assert.equal(f.providerCalls, 1); assert.equal(f.session.snapshot().running, false);
  } finally { await f.cleanup(); }
});

test('service runs optional practice independently and feeds its measured results into the next supervisor review after restart', async () => {
  const f = await fixture(true);
  try {
    await f.service.enable(); const initialState = await f.source.state(), id = randomUUID();
    await f.service.start({ kind: 'propose', id, proposalKind: 'guidance' }); await settled(f.service);
    const before = f.session.checkpoint(); assert.deepEqual(await f.source.state(), initialState);
    const menu = f.requests[0]!.training!;
    assert.equal(menu.maximumSelection, 2); assert.equal(menu.scenarios.length, 3);
    await f.service.start({ kind: 'evaluate', id: randomUUID(), proposalId: id });
    const view = await settled(f.service);
    assert.equal(view.jobs[0]!.status, 'complete', JSON.stringify(view.jobs));
    assert.equal(view.proposals[0]!.result?.accepted, false); assert.equal(view.active?.epoch, 0);
    assert.deepEqual(f.session.checkpoint(), before); assert.equal(f.source.destroyed, false);
    const preview = await f.service.evaluationView(id);
    assert.equal(preview.runs.filter(run => run.purpose === 'practice').length, 2);
    assert.equal(preview.total, 10); assert.equal(preview.finished, 4);
    const replay = preview.runs.find(run => run.purpose === 'practice' && run.replay)!;
    assert.equal((await f.service.evaluationReplayFrames(id, replay.id, 0, 1)).length, 1);
    assert.equal(f.points.size, 1, 'retain one observed practice checkpoint, not a running world'); assert.ok([...f.worlds.values()].every(world => world.destroyed));
    const retained = new Map([...f.points].map(([reference, state]) => [reference, structuredClone(state)]));
    const modelCalls = f.modelCalls; await f.reopen(); assert.equal(f.modelCalls, modelCalls);
    await f.session.takeover(f.source.id); await f.session.input(f.source.id, ['forward']); f.session.release(f.source.id);
    await f.service.start({ kind: 'propose', id: randomUUID(), proposalKind: 'guidance' }); await settled(f.service);
    const previous = f.requests.at(-1)!.previousExperiments as Array<{ outcome: { practice: { purpose: string; results: unknown[] } } }>;
    assert.equal(previous[0]!.outcome.practice.purpose, 'practice'); assert.equal(previous[0]!.outcome.practice.results.length, 1);
    assert.equal(f.modelCalls, modelCalls); assert.equal(f.providerCalls, 2);
    assert.ok(f.requests.at(-1)!.training!.scenarios[0]!.id.startsWith('observed-'));
    const second = f.service.view().proposals[0]!.id;
    // Move the selected old checkpoint outside the four-position reservoir. The
    // pending proposal must keep its exact practice input alive across restart.
    for (let index = 0; index < 4; index++) {
      await f.session.takeover(f.source.id); await f.session.input(f.source.id, ['forward']); f.session.release(f.source.id);
      await f.service.start({ kind: 'propose', id: randomUUID(), proposalKind: 'guidance' }); await settled(f.service);
    }
    for (const [reference, state] of retained) assert.deepEqual(f.points.get(reference), state);
    await f.reopen();
    const currentGame = f.session.checkpoint();
    await f.service.start({ kind: 'evaluate', id: randomUUID(), proposalId: second }); const checked = await settled(f.service);
    assert.equal(checked.jobs[0]!.status, 'complete', JSON.stringify(checked.jobs));
    assert.equal(checked.proposals.find(proposal => proposal.id === second)!.result?.accepted, false);
    assert.deepEqual(f.session.checkpoint(), currentGame);
    const observed = await f.service.evaluationView(second);
    const practiceRun = observed.runs.find(run => run.scenarioId.startsWith('practice/observed-') && run.replay)!;
    assert.ok(practiceRun); assert.match(observed.labels![practiceRun.scenarioId]!, /Observed E1M1/);
    for (const reference of retained.keys()) assert.equal(f.points.has(reference), false, 'release old practice input only after its borrowing proposal has joined cleanup');
    assert.equal(f.points.size, 5, 'four recent positions plus one selected by another pending proposal'); assert.equal(f.providerCalls, 6);
  } finally { await f.cleanup(); }
});

test('explicit adoption with automatic startup disabled preserves the guide/settings, and restores its binding without provider calls', async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.view().enabled, false); assert.equal(f.session.checkpoint().version, 1);
    const before = f.session.checkpoint(), policy = f.session.learningPolicy(); await f.service.enable();
    assert.equal(f.session.checkpoint().version, 2); assert.equal(f.service.view().active?.epoch, 0);
    assert.deepEqual(f.session.learningPolicy(), policy);
    assert.equal(f.session.snapshot().pendingObjective, before.view.pendingObjective);
    const binding = f.session.checkpoint().learning;
    await f.reopen(); assert.equal(f.service.view().enabled, true); assert.deepEqual(f.session.checkpoint().learning, binding);
    assert.equal(f.providerCalls, 0); assert.equal(f.modelCalls, 0); assert.equal(f.source.destroyed, false);
  } finally { await f.cleanup(); }
});

test('service proposals and paired evaluation survive restart without duplicate spending or live-game mutation', async () => {
  const f = await fixture();
  try {
    await f.service.enable(); const id = randomUUID();
    // Capturing applies the queued guide at the same safe boundary as normal play.
    const expectedWorld = await f.source.state();
    await f.service.start({ kind: 'propose', id }); let view = await settled(f.service);
    assert.equal(view.proposals.length, 1, JSON.stringify(view.jobs)); assert.equal(view.proposals[0]!.status, 'proposed');
    assert.equal(view.budget.costMicros, 123); assert.equal(view.budget.proposalCalls, 1); assert.equal(view.active?.epoch, 0);
    assert.equal(view.budget.inputTokens, 12); assert.equal(view.budget.outputTokens, 4); assert.equal(view.budget.unknownTokenCalls, 0);
    assert.deepEqual(await f.source.state(), expectedWorld);
    assert.equal(f.points.size, 1, 'retain the actual source situation until its comparison finishes');
    const before = f.session.checkpoint();
    assert.deepEqual((await f.service.detail(id)).servingModels, ['fixture']);
    const evaluation = { kind: 'evaluate' as const, id: randomUUID(), proposalId: id };
    await f.service.start(evaluation); view = await settled(f.service);
    assert.equal(view.jobs[0]!.status, 'complete', JSON.stringify(view.jobs));
    assert.equal(view.proposals[0]!.result?.accepted, false); assert.equal(view.proposals[0]!.result?.cases, 1);
    assert.equal(f.modelCalls, 128); assert.equal(view.budget.liveModelCalls, 0);
    assert.equal(f.points.size, 1, 'retain one observed practice checkpoint, not a running world'); assert.ok([...f.worlds.values()].every(world => world.destroyed));
    const preview = await f.service.evaluationView(id);
    assert.equal(preview.total, 8); assert.equal(preview.finished, 2); assert.equal(preview.active, false);
    assert.ok(preview.runs.slice(0, 2).every(run => run.status === 'complete'));
    assert.ok(preview.runs.slice(2).every(run => run.status === 'not-run'));
    assert.match(view.proposals[0]!.result!.reason, /remaining test games were skipped/);
    await assert.rejects(f.service.evaluationView(randomUUID()), /Unknown learning proposal/);

    await assert.rejects(f.service.activate(id)); assert.deepEqual(f.session.checkpoint(), before);
    await f.reopen(); await f.service.start({ kind: 'propose', id }); await f.service.start(evaluation);
    assert.equal(f.providerCalls, 1); assert.equal(f.modelCalls, 128); assert.equal(f.service.view().budget.costMicros, 123);
    assert.equal(f.service.view().budget.inputTokens, 12); assert.equal(f.service.view().budget.unknownTokenCalls, 0);
    assert.equal(f.service.view().active?.epoch, 0); assert.equal(f.source.destroyed, false);
  } finally { await f.cleanup(); }
});

test('a changed build cannot reopen a supervised game and a changed guide makes proposals stale', async () => {
  const f = await fixture();
  try {
    await f.service.enable(); const id = randomUUID(); await f.service.start({ kind: 'propose', id }); await settled(f.service);
    f.session.queueObjective('Collect supplies before fighting');
    assert.equal(f.service.view().proposals[0]!.stale, true); assert.equal(f.service.view().proposals[0]!.canEvaluate, false);
    await f.service.start({ kind: 'evaluate', id: randomUUID(), proposalId: id }); const view = await settled(f.service);
    assert.equal(view.jobs[0]!.status, 'complete'); assert.equal(view.proposals[0]!.status, 'stale'); assert.equal(f.modelCalls, 0);
    await f.service.close();
    await assert.rejects(DoomLearningService.open({ ...f.options, build: { ...f.options.build, node: 'changed' } }, f.session.checkpoint().learning!.binding), /original gameplay build/);
  } finally { await f.cleanup(); }
});

test('new requests pin the chosen CLI, default to Codex and cannot switch providers on retry', async () => {
  const f = await fixture(), selected: string[] = [];
  const original = f.options.proposalProvider!;
  f.options.proposalProvider = async (record, provider) => { selected.push(provider); return original(record, provider); };
  // Reopen so the service captures this trusted provider factory.
  try {
    await f.reopen(); await f.service.enable();
    const id = randomUUID(); await f.service.start({ kind: 'propose', id }); await settled(f.service);
    assert.equal(f.service.view().jobs[0]!.status, 'complete');
    assert.equal(f.service.view().jobs[0]!.provider, 'codex');
    await f.service.start({ kind: 'propose', id }); assert.deepEqual(selected, ['codex']);
    await assert.rejects(f.service.start({ kind: 'propose', id, provider: 'claude' }), /different request/);
    await f.service.start({ kind: 'propose', id: randomUUID(), provider: 'claude' }); await settled(f.service);
    assert.deepEqual(selected, ['codex', 'claude']); assert.equal(f.service.view().budget.costLimitMicros, null);
    await f.reopen(); assert.equal(f.service.view().jobs[0]!.provider, 'claude');
    assert.equal(f.service.view().budget.proposalCalls, 2);
  } finally { await f.cleanup(); }
});

test('a historical cost overrun remains accounted without blocking new uncapped requests', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close();
    const manifest = JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'));
    const legacy = { version: 1, spec: manifest.generationBudget, entries: [{ id: 1, owner: 'legacy', operation: 'doom-revision-proposal',
      reserved: { supervisorCalls: 1, costMicros: 500000 }, usage: { supervisorCalls: 1, costMicros: 509488 }, status: 'overrun' }] };
    const bytes = JSON.stringify(legacy); await writeFile(join(f.directory, 'proposal-budget.json'), bytes);
    await f.reopen(); assert.equal(f.service.view().budget.costMicros, 509488);
    await f.service.start({ kind: 'propose', id: randomUUID(), provider: 'codex' }); await settled(f.service);
    assert.equal(f.service.view().jobs[0]!.status, 'complete');
    assert.equal(f.service.view().budget.costMicros, 509611); assert.equal(f.service.view().budget.proposalCalls, 2);
    assert.equal(await readFile(join(f.directory, 'proposal-budget.json'), 'utf8'), bytes);
    await f.reopen(); assert.equal(f.service.view().budget.costMicros, 509611);
  } finally { await f.cleanup(); }
});

test('background learning observes play and automatically generates and tests an improvement without manual jobs', async () => {
  const f = await fixture();
  try {
    f.options.backgroundLearning = true;
    class TerminalEvaluation extends Runtime {
      override async step(command: Parameters<Runtime['step']>[0]) {
        const state = await super.step(command); return { ...state, alive: state.tick < 140, health: state.tick < 140 ? state.health : 0 };
      }
    }
    f.options.runtime!.create = async id => { const world = new TerminalEvaluation(id); f.worlds.set(id, world); return world; };
    f.options.runtime!.restore = async (ref, id) => {
      const world = Object.assign(new TerminalEvaluation(id, structuredClone(f.points.get(ref)!)), { parent: 'physical-' + ref });
      f.worlds.set(id, world); return world;
    };
    await f.reopen();
    f.session.setTrialDuration(35);
    for (let turn = 0; turn < 32; turn++) { f.session.step(); await f.session.idle(); }
    assert.ok(f.session.snapshot().stats!.attempts.seconds >= 30);
    const before = f.session.snapshot(); await f.service.enable();
    assert.equal(f.service.view().automation?.enabled, true);
    const deadline = Date.now() + 60000;
    while (!f.service.view().automation?.lastOutcome) {
      assert.ok(Date.now() < deadline, JSON.stringify({automation:f.service.view().automation,jobs:f.service.view().jobs}));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(f.providerCalls, 1);
    const view = f.service.view();
    assert.deepEqual(view.jobs.map(job => job.kind), ['evaluate', 'propose']);
    assert.equal(view.automation!.lastOutcome!.status, 'rejected');
    assert.equal(view.active!.epoch, 0);
    assert.deepEqual(f.session.snapshot().stats, before.stats);
    assert.equal(f.session.snapshot().mainId, before.mainId);
    assert.equal(view.automation!.cycle, undefined);
    await f.service.setAutomation(false, 'claude');
    assert.equal(f.service.view().automation!.enabled, false); assert.equal(f.service.view().automation!.provider, 'claude');
  } finally { await f.cleanup(); }
});


test('normal startup enables background learning without a proposal or an enable command', async () => {
  const f = await fixture();
  try {
    f.options.backgroundLearning = true;
    await f.reopen();
    assert.equal(f.service.view().enabled, true);
    const { strategy, ...status } = f.service.backgroundView();
    assert.deepEqual(strategy?.guidance, []); assert.equal(strategy?.activation.epoch, 0);
    assert.deepEqual(status, { ready: true, enabled: true, provider: 'codex', stage: 'watching', error: undefined, proposalId: undefined, reason: undefined, result: undefined });
    assert.equal(f.providerCalls, 0);
    assert.ok((await f.store.load())!.learning);
    await f.service.setAutomation(false, 'claude');
    await f.reopen();
    const { strategy: retainedStrategy, ...paused } = f.service.backgroundView();
    assert.deepEqual(retainedStrategy, strategy);
    assert.deepEqual(paused, { ready: true, enabled: false, provider: 'claude', stage: 'paused', error: undefined, proposalId: undefined, reason: undefined, result: undefined });
    assert.equal(f.providerCalls, 0);
  } finally { await f.cleanup(); }
});

test('offline build handoff keeps game state and historical references without reusing qualification', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { readFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable();
    const previousId = randomUUID();
    await f.service.start({ kind: 'propose', id: previousId }); await settled(f.service);
    await f.service.start({ kind: 'evaluate', id: randomUUID(), proposalId: previousId }); await settled(f.service);
    assert.equal(f.service.view().proposals[0]!.status, 'rejected');
    await f.service.close();
    const saved = f.session.checkpoint(), original = await readFile(join(f.directory, 'supervisor.json'), 'utf8');
    const { doomLearningProvenance } = await import('./doom-learning.ts');
    saved.worlds[0]!.view.learning = doomLearningProvenance(f.service.binding!, f.service.binding!.current().activation);
    const newBuild = { ...f.options.build, revision: contentRevision('fixture-build-v2', { change: 'decision cadence' }) };
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, { ...saved, view: { ...saved.view, running: true } }, newBuild), /Pause/);
    const upgraded = await prepareDoomBuildUpgrade(f.directory, saved, newBuild);
    assert.notDeepEqual(upgraded.learning!.binding, saved.learning!.binding);
    assert.deepEqual(upgraded.worlds, saved.worlds);
    assert.deepEqual(upgraded.view, saved.view);
    assert.equal(await readFile(join(f.directory, 'supervisor.json'), 'utf8'), original);
    const service = await DoomLearningService.open({ ...f.options, build: newBuild }, upgraded.learning!.binding);
    try {
      const session = new Session({ decide: async () => decision }, undefined, service.binding);
      await session.restore(upgraded, async () => f.source);
      assert.deepEqual(session.snapshot().worlds[0]!.state, f.session.snapshot().worlds[0]!.state);
      assert.equal(service.binding!.current().activation.epoch, 0);
      assert.equal(service.binding!.current().artifact.adapter.version, newBuild.revision.version);
      assert.deepEqual(session.snapshot().worlds[0]!.learning, saved.worlds[0]!.view.learning);
      session.setPersistence(async () => {});
      session.setCheckpointAdapter({ capture: f.options.runtime!.capture, restore: f.options.runtime!.restore, remove: async ref => { f.points.delete(ref); } });
      await service.attach(session);
      const nextId = randomUUID(); await service.start({ kind: 'propose', id: nextId }); await settled(service);
      const { doomLearningDirectory } = await import('./doom-learning-lineage.ts');
      const directory = await doomLearningDirectory(f.directory, upgraded.learning!.binding);
      const proposal = JSON.parse(await readFile(join(directory, 'proposals', nextId + '.json'), 'utf8'));
      const previous = proposal.request.evidence.previousExperiments;
      assert.equal(previous.length, 1); assert.equal(previous[0].historicalBuild, true);
      assert.equal(previous[0].sameUserContext, false); assert.equal(previous[0].status, 'rejected');
      assert.equal(previous[0].outcome.savedSituation.runs.length, 2);
      assert.equal(service.view().proposals[0]!.status, 'proposed', 'historical evidence never qualifies a new proposal');
      assert.equal(await readFile(join(f.directory, 'supervisor.json'), 'utf8'), original);
    } finally { await service.close(); }
  } finally { await f.cleanup(); }
});


test('interrupted offline preparation keeps the old checkpoint usable until the new binding is published', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { readFile, readdir } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close(); await f.store.flush();
    const saved = (await f.store.load())!;
    const checkpointBytes = await readFile(join(f.directory, 'session.json'), 'utf8');
    const journalBytes = await readFile(join(f.directory, 'supervisor.json'), 'utf8');
    const nextBuild = { ...f.options.build, revision: contentRevision('fixture-build-v2', { change: 'interrupted publication' }) };
    const wrongSource = { ...nextBuild, files: { 'examples/doom/server/src/doom-learning-upgrade.ts': 'sha256:wrong-digest' } };
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, saved, wrongSource), /source changed/);
    assert.equal(await readFile(join(f.directory, 'session.json'), 'utf8'), checkpointBytes);
    assert.equal(await readFile(join(f.directory, 'supervisor.json'), 'utf8'), journalBytes);
    await f.reopen();
    assert.deepEqual(f.session.checkpoint().learning!.binding, saved.learning!.binding);
    assert.deepEqual(await f.source.state(), saved.worlds[0]!.view.state);
    await f.service.close();

    // Kill a real preparation process after it stages a complete lineage, but
    // before the caller publishes the session binding. The OS must release its lease.
    const { spawn } = await import('node:child_process');
    const { acquireDataLease } = await import('./data-lease.ts');
    const worker = `
      import { prepareDoomBuildUpgrade } from './examples/doom/server/src/doom-learning-upgrade.ts';
      import { acquireDataLease } from './examples/doom/server/src/data-lease.ts';
      import { SessionStore } from './examples/doom/server/src/persistence.ts';
      import { join } from 'node:path';
      const lease = await acquireDataLease(process.argv[1]);
      const saved = await new SessionStore(join(lease.directory, 'session.json')).load();
      const prepared = await prepareDoomBuildUpgrade(lease.directory, saved, JSON.parse(process.argv[2]));
      process.on('message', () => {});
      process.send({ prepared });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.directory, JSON.stringify(nextBuild)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let prepared: ReturnType<Session['checkpoint']>;
    try {
      prepared = await new Promise<ReturnType<Session['checkpoint']>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Upgrade worker did not prepare: ' + stderr)), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Upgrade worker exited before interruption: ' + stderr)); });
        child.once('message', value => { clearTimeout(timer); resolve((value as { prepared: ReturnType<Session['checkpoint']> }).prepared); });
      });
      child.kill('SIGKILL');
      assert.equal((await exited).signal, 'SIGKILL');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
    const recoveredLease = await acquireDataLease(f.directory); await recoveredLease.release();
    assert.deepEqual((await f.store.load())!.learning!.binding, saved.learning!.binding);
    await f.reopen();
    assert.deepEqual(f.service.binding!.identity, saved.learning!.binding);
    await f.service.close();
    const { collectDoomUpgradeWork } = await import('./doom-upgrade-work.ts');
    const abandonedDirectory = join(f.directory, 'lineages', prepared.learning!.binding.version);
    const collected = await collectDoomUpgradeWork(f.directory, [saved.learning!.binding]);
    assert.equal(collected.removed.length, 2, 'the source-retention failure and killed unpublished upgrade are reclaimed');
    await assert.rejects(readFile(join(abandonedDirectory, 'manifest.json')), { code: 'ENOENT' });
    prepared = await prepareDoomBuildUpgrade(f.directory, saved, nextBuild);
    await f.store.save(prepared); await f.store.flush();
    f.options.build = nextBuild;
    await f.reopen();
    assert.deepEqual(f.service.binding!.identity, prepared.learning!.binding);
    assert.deepEqual(f.session.snapshot().worlds[0]!.state, saved.worlds[0]!.view.state);
    assert.equal(f.service.view().active!.epoch, 0);
    assert.equal(f.providerCalls, 0); assert.equal(f.modelCalls, 0); assert.equal(f.source.destroyed, false);
    await f.service.close();
    const directories = await readdir(join(f.directory, 'lineages'));
    const unchanged = await prepareDoomBuildUpgrade(f.directory, prepared, nextBuild);
    assert.deepEqual(unchanged, prepared);
    assert.deepEqual(await readdir(join(f.directory, 'lineages')), directories, 'repeating the published build is a no-op');
    assert.equal(await readFile(join(f.directory, 'supervisor.json'), 'utf8'), journalBytes);
  } finally { await f.cleanup(); }
});

test('offline handoff refuses an unresolved comparison and an interrupted supervisor evaluation', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable();
    const id = randomUUID(); await f.service.start({ kind: 'propose', id }); await settled(f.service);
    const nextBuild = { ...f.options.build, revision: contentRevision('fixture-build-v2', { change: 'active work' }) };
    const ready = f.session.checkpoint();
    f.session.step(); await f.session.idle();
    const comparing = f.session.checkpoint();
    assert.ok(comparing.experiments.length > 0);
    await f.service.close();
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, comparing, nextBuild), /resolved AI decision boundary/);
    const path = join(f.directory, 'supervisor.json');
    const original = await readFile(path, 'utf8'), interrupted = JSON.parse(original);
    interrupted.journal.proposals.find((proposal: { id: string }) => proposal.id === id).status = 'evaluating';
    const interruptedBytes = JSON.stringify(interrupted);
    await writeFile(path, interruptedBytes);
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, ready, nextBuild), /Finish or reconcile historical evaluations/);
    assert.equal(await readFile(path, 'utf8'), interruptedBytes, 'upgrade cannot reconcile or resume unfinished evaluation');
    assert.deepEqual(ready.learning, comparing.learning);
    assert.equal(f.providerCalls, 1); assert.equal(f.modelCalls, 1, 'only the explicit fixture comparison made a decision');
    assert.equal(f.source.destroyed, false);
  } finally { await f.cleanup(); }
});

test('tampered archived history prevents reopening or preparing another build without changing the selected checkpoint', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { doomLearningDirectory } = await import('./doom-learning-lineage.ts');
  const { readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close();
    const saved = (await f.store.load())!;
    const nextBuild = { ...f.options.build, revision: contentRevision('fixture-build-v2', { change: 'history integrity' }) };
    const prepared = await prepareDoomBuildUpgrade(f.directory, saved, nextBuild);
    await f.store.save(prepared); await f.store.flush();
    const checkpointBytes = await readFile(join(f.directory, 'session.json'), 'utf8');
    const directory = await doomLearningDirectory(f.directory, prepared.learning!.binding);
    const historyPath = join(directory, 'history.json'), original = await readFile(historyPath, 'utf8');
    const changed = JSON.parse(original); changed.lineages[0].journal.active.epoch = 42;
    await writeFile(historyPath, JSON.stringify(changed));
    await assert.rejects(DoomLearningService.open({ ...f.options, build: nextBuild }, prepared.learning!.binding), /history content mismatch/);
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, prepared, { ...nextBuild,
      revision: contentRevision('fixture-build-v3', { change: 'next' }) }), /history content mismatch/);
    assert.equal(await readFile(join(f.directory, 'session.json'), 'utf8'), checkpointBytes);
    await writeFile(historyPath, original);
    f.options.build = nextBuild; await f.reopen();
    assert.deepEqual(f.service.binding!.identity, prepared.learning!.binding);
    assert.deepEqual(await f.source.state(), saved.worlds[0]!.view.state);
    assert.equal(f.providerCalls, 0); assert.equal(f.modelCalls, 0);
  } finally { await f.cleanup(); }
});

test('upgrade cleanup reclaims only owned unpublished work and leaves changed or unmarked directories intact', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { collectDoomUpgradeWork } = await import('./doom-upgrade-work.ts');
  const { access, mkdir, readFile, writeFile, symlink } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close();
    const saved = (await f.store.load())!, original = await readFile(join(f.directory, 'session.json'), 'utf8');
    const build = { ...f.options.build, revision: contentRevision('fixture-build-v2', { change: 'cleanup' }) };
    await assert.rejects(prepareDoomBuildUpgrade(f.directory, saved, { ...build,
      files: { 'examples/doom/server/src/doom-learning-upgrade.ts': 'sha256:wrong' } }), /source changed/);
    const abandoned = await prepareDoomBuildUpgrade(f.directory, saved, build);
    const changed = await prepareDoomBuildUpgrade(f.directory, saved, build);
    const changedDirectory = join(f.directory, 'lineages', changed.learning!.binding.version);
    const journal = JSON.parse(await readFile(join(changedDirectory, 'supervisor.json'), 'utf8'));
    journal.modifiedAfterPreparation = true;
    await writeFile(join(changedDirectory, 'supervisor.json'), JSON.stringify(journal));
    const legacy = join(f.directory, 'lineages', randomUUID()); await mkdir(legacy);
    const unknown = join(f.directory, '.upgrade-work', randomUUID()); await mkdir(unknown);
    const outside = join(f.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'owned elsewhere');
    const link = join(f.directory, '.upgrade-work', randomUUID()); await symlink(outside, link);
    const result = await collectDoomUpgradeWork(f.directory, [saved.learning!.binding]);
    assert.equal(result.removed.length, 2, 'failed staging and unchanged unpublished lineage are collected');
    assert.equal(result.retained.length, 3, 'changed, unknown and symbolic-link entries remain untouched');
    await assert.rejects(access(join(f.directory, 'lineages', abandoned.learning!.binding.version)));
    for (const path of [changedDirectory, legacy, unknown, link, join(outside, 'keep')]) await access(path);
    assert.equal(await readFile(join(f.directory, 'session.json'), 'utf8'), original);
    assert.equal(f.source.destroyed, false); assert.equal(f.providerCalls, 0);
    assert.deepEqual(await collectDoomUpgradeWork(f.directory, [saved.learning!.binding]), { removed: [], retained: result.retained });
  } finally { await f.cleanup(); }
});

test('upgrade cleanup protects the current binding, embedded historical lineages and rollback backups', async () => {
  const { prepareDoomBuildUpgrade } = await import('./doom-learning-upgrade.ts');
  const { collectDoomUpgradeWork, doomUpgradeReferences } = await import('./doom-upgrade-work.ts');
  const { access, readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close();
    const saved = (await f.store.load())!;
    const build = (n: number) => ({ ...f.options.build, revision: contentRevision('fixture-build', { n }) });
    const first = await prepareDoomBuildUpgrade(f.directory, saved, build(2));
    const current = await prepareDoomBuildUpgrade(f.directory, first, build(3));
    const backup = await prepareDoomBuildUpgrade(f.directory, saved, build(4));
    await f.store.save(current); await f.store.flush();
    await new SessionStore(join(f.directory, 'session-before-build-upgrade-123.json')).save(backup);
    const roots = await doomUpgradeReferences(f.directory);
    assert.deepEqual(roots, [current.learning!.binding, backup.learning!.binding]);
    const historyPath = join(f.directory, 'lineages', current.learning!.binding.version, 'history.json');
    const history = await readFile(historyPath, 'utf8'), changed = JSON.parse(history); changed.lineages.pop();
    await writeFile(historyPath, JSON.stringify(changed));
    await assert.rejects(collectDoomUpgradeWork(f.directory, roots), /history content mismatch/);
    await writeFile(historyPath, history);
    const result = await collectDoomUpgradeWork(f.directory, roots);
    assert.equal(result.removed.length, 3); assert.deepEqual(result.retained, []);
    for (const checkpoint of [first, current, backup]) await access(join(f.directory, 'lineages', checkpoint.learning!.binding.version, 'manifest.json'));
    assert.deepEqual((await f.store.load())!.learning, current.learning);
    assert.equal(f.providerCalls, 0); assert.equal(f.modelCalls, 0);
  } finally { await f.cleanup(); }
});

test('an edited goal reaches the automatic supervisor after restart without needing failed gameplay', async () => {
  const f = await fixture();
  try {
    f.session.setRecorder(async () => { void f.session.pause(); });
    f.session.resume(); await f.session.idle(); await f.session.pause();
    await f.store.save(f.session.checkpoint());
    f.options.backgroundLearning = true;
    const original = f.options.proposalProvider!, received: string[] = [];
    f.options.proposalProvider = async (...args) => {
      const provider = await original(...args);
      return { ...provider, propose: async (...request) => {
        received.push(request[0].objective); return provider.propose(...request);
      } };
    };
    await f.reopen();
    f.session.queueObjective('Avoid unnecessary combat and find the exit');
    f.session.setRecorder(async () => { void f.session.pause(); });
    f.session.resume(); await f.session.idle(); await f.session.pause();
    await f.store.save(f.session.checkpoint());
    assert.equal(f.session.snapshot().stats!.attempts.planFailures ?? 0, 0);
    await f.reopen(); // The old baseline must survive even though no review has run yet.
    const deadline = Date.now() + 10000;
    while (!received.length) {
      assert.ok(Date.now() < deadline, JSON.stringify({ goal: f.session.snapshot().objective, pending: f.session.snapshot().pendingObjective, automation: f.service.view().automation, jobs: f.service.view().jobs }));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(received, ['Avoid unnecessary combat and find the exit']);
    await settled(f.service);
    await f.service.setAutomation(false, 'codex');
    await f.reopen();
    assert.equal(f.providerCalls, 1);
    assert.equal(f.service.view().automation!.enabled, false);
  } finally { await f.cleanup(); }
});


test('exhausted historical live limits retain accounting while new gameplay continues uncapped', async () => {
  const { BudgetLedger } = await import('@multiverse/gameplay-harness');
  const { readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await f.service.enable(); await f.service.close();
    const spec = { simulationUnit: 'doom-ticks', limits: { modelCalls: 10000, executorCalls: 1000 } };
    const old = new BudgetLedger(spec);
    await old.run({ owner: 'historical-game', operation: 'play', reserve: { modelCalls: 10000, executorCalls: 1000 } },
      async () => ({ value: undefined, usage: { modelCalls: 10000, executorCalls: 1000 } }));
    const path = join(f.directory, 'live-budget.json'), bytes = JSON.stringify(old.snapshot());
    await writeFile(path, bytes);
    await f.reopen();
    f.session.setRecorder(async () => { void f.session.pause(); });
    f.session.resume(); await f.session.idle(); await f.session.pause();
    assert.equal(f.session.snapshot().error, undefined);
    assert.ok(f.service.view().budget.liveModelCalls > 10000, 'actual live model decision passes the old exhausted cap');
    assert.equal(f.service.view().budget.liveModelCallLimit, null);
    assert.equal(f.service.view().budget.liveExecutorCallLimit, null);
    assert.equal(f.service.view().budget.liveExecutorCalls, 1000);
    assert.equal(await readFile(path, 'utf8'), bytes, 'historical usage is not rewritten or reset');
    const usage = JSON.parse(await readFile(join(f.directory, 'live-usage.json'), 'utf8'));
    const live = new BudgetLedger(usage.spec, undefined, usage);
    assert.equal(live.remaining('executorCalls'), Infinity);
    const calls = f.service.view().budget.liveModelCalls;
    await f.reopen();
    assert.equal(f.service.view().budget.liveModelCalls, calls);
    assert.equal(await readFile(path, 'utf8'), bytes);
  } finally { await f.cleanup(); }
});
