import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import type { EvaluationContract } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomVmEvaluations, type DoomVmScenario } from './doom-vm-evaluations.ts';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { doomSurvivalProgress } from './doom-revision-evaluation.ts';
import { Session, sessionContinuation } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { doomIncidentCheckpoint, DoomEvaluationVms, decodeDoomEvaluationVms, type DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';
import type { GameState } from '../../contracts/src/game.ts';
import { Recordings } from './recordings.ts';
import { openDoomEvaluationRecording, type DoomEvaluationRecordingManifest } from './doom-evaluation-recording.ts';
import { LearningEvaluationReader } from './learning-evaluation-view.ts';
import { doomTrainingCatalog, doomTrainingContract } from './doom-curriculum.ts';
import { BudgetLedger, trainingMenu } from '@multiverse/gameplay-harness';

async function recordingFor(root: string, proposal: string, runId: string) {
  const directory = join(root, proposal, 'runs', contentRevision('doom-evaluation-run', runId).version.slice(7));
  const manifest: DoomEvaluationRecordingManifest = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
  assert.equal(manifest.state, 'finished'); assert.equal(manifest.error, undefined);
  const recordings = new Recordings(join(directory, 'recordings')); await recordings.open();
  assert.deepEqual(await recordings.path(manifest.path!.endpointId), manifest.path);
  for (const segment of manifest.path!.segments) for (const [offset, tick] of segment.ticks.entries()) {
    const frame = await recordings.get(segment.worldId, segment.firstFrame + offset);
    assert.equal(frame.world.state.tick, tick);
    assert.equal(JSON.parse(Buffer.from(frame.frame, 'base64').toString()).tick, tick);
  }
  return manifest;
}

async function fixture(completeFutures = false) {
  const root = await mkdtemp(join(tmpdir(), 'doom-vm-composition-'));
  const worlds = new Map<string, Runtime>(), points = new Map<string, GameState>();
  let calls = 0, creations = 0, contextVersion = '1';
  const hooks: { decide?: () => Promise<void> } = {};
  const client = { systemOne: async (body: any) => {
    calls++; await hooks.decide?.();
    return { model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
      const ids = Object.keys(question.criteria), choice = ids.includes('wait') ? 'wait' : ids[0];
      return [key, { choice, confidence: completeFutures ? 0.5 : 1, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
    })) };
  } } as unknown as Pick<TypeSafeClient, 'systemOne'>;
  const models = () => new DoomLearningModels({ adapter: { id: 'fixture', version: '1' }, builtinExecutor: { id: 'fixture-host', version: '1' }, profile: 'game-aware', client,
    executables: new ExecutableStore(join(root, 'source')), executable: () => { throw new Error('No executable dispatch in this fixture'); } });
  const policy = new Session({ decide: async () => decision }, { threshold: 0, horizon: 7, branches: 2, paceMs: 0 }).learningPolicy();
  policy.planningMode = 'actions'; policy.decisionTicks = 7; policy.recovery.enabled = true;
  if (completeFutures) { policy.trialTicks = 35; policy.forkThreshold = 0.75; policy.decisionIntervalMode = 'trial'; }
  const baseline = models().baseline(policy), { revision: _, ...fields } = baseline;
  const candidate = doomLearningArtifact({ ...fields, prompts: { action: 'Measure progress.' } });
  const contract: EvaluationContract<DoomVmScenario> = { id: 'composition-fixture', evaluator: { id: 'fixture-metric', version: '1' },
    ...(completeFutures ? { allowance: 'complete-futures-v1' as const } : {}),
    scenarios: [{ id: 'first', seed: 'fixture', input: { setup: [{ ticks: 7, inputs: [] }], ...(completeFutures ? { minimumSelectedTicks: 14 } : {}) } }],
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: 100, modelCalls: 2 } }, maxRunMs: 10000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
  const ports: DoomEvaluationVmPorts = {
    create: async id => { creations++; const world = new Runtime(id); worlds.set(id, world); return world; },
    destroy: async (id, identity) => { const world = worlds.get(id); if (!world) return; assert.ok(!identity || world.identity === identity); await world.destroy(); worlds.delete(id); },
    capture: async (world, ref) => { points.set(ref, await world.state()); },
    restore: async (ref, id) => { const world = Object.assign(new Runtime(id, structuredClone(points.get(ref)!)), { parent: 'physical-' + ref }); worlds.set(id, world); return world; },
    parentSnapshot: async world => (world as Runtime & { parent?: string }).parent,
    snapshotIdentity: async ref => points.has(ref) ? 'physical-' + ref : undefined,
    collect: async requested => { for (const point of requested) points.delete(point.reference); return []; },
  };
  const options = { directory: root, contract, runtime: ports, models,
    context: () => ({ revision: { id: 'fixture-guide', version: contextVersion }, value: { objective: 'Stay alive', skills: [], overrides: {} } }), measure: doomSurvivalProgress };
  const evaluator = new DoomVmEvaluations(options);
  const request = { proposalId: randomUUID(), baseline, candidate, contract: evaluator.version, context: { id: 'fixture-guide', version: '1' } };
  return { root, worlds, points, evaluator, options, request, hooks, get calls() { return calls; }, get creations() { return creations; },
    changeContext: () => { contextVersion = '2'; },
    cleanup: async () => { await evaluator.recover(); await rm(root, { recursive: true, force: true }); } };
}

test('production evaluator composition writes a complete paired experiment, exercises recovery and cannot repeat the job', async () => {
  const f = await fixture();
  try {
    const result = await f.evaluator.qualify(f.request, new AbortController().signal);
    assert.equal(result.accepted, false); assert.match(result.reason, /mean improvement/); assert.equal(f.calls, 4);
    const report = JSON.parse(await readFile(join(f.root, f.request.proposalId, 'comparison.json'), 'utf8'));
    assert.deepEqual(report.runs.map((run: any) => run.status), ['complete', 'complete']);
    for (const run of report.runs) {
      assert.equal(run.evidence.session.objective, 'Stay alive');
      assert.equal(run.budget.entries.reduce((sum: number, entry: any) => sum + (entry.usage?.simulation ?? 0), 0), 56);
      const recording = await recordingFor(f.root, f.request.proposalId, run.id);
      assert.equal(recording.path!.frames, run.evidence.final.tick - run.evidence.initial.tick + 1);
      assert.equal(recording.path!.lastTick, run.evidence.final.tick);
    }
    const resources = JSON.parse(await readFile(join(f.root, f.request.proposalId, 'resources.json'), 'utf8'));
    assert.ok(resources.runs.every((run: any) => run.closed && run.checkpoints.length && run.checkpoints.every((point: any) => point.released)));
    assert.equal(f.points.size, 0); assert.ok([...f.worlds.values()].every(world => world.destroyed));
    await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal), /already admitted/);
    const reopened = new DoomVmEvaluations(f.options); await reopened.recover();
    await assert.rejects(reopened.qualify(f.request, new AbortController().signal), /already admitted/);
    assert.equal(f.calls, 4); assert.equal(f.creations, 2);
  } finally { await f.cleanup(); }
});

test('startup recovers only admitted recordings without dispatching gameplay or creating results', async () => {
  const f = await fixture();
  const session = new Session({ decide: async () => decision });
  try {
    const root = join(f.root, f.request.proposalId);
    const id = contentRevision('doom-evaluation-run', 'composition-fixture/first/baseline').version.slice(7);
    const directory = join(root, 'runs', id);
    const writer = await openDoomEvaluationRecording(directory);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, contract: f.options.contract }));
    await session.initialize(new Runtime('saved-root'));
    const view = session.snapshot();
    await writer.record(view.worlds[0]!, session.frame(view.mainId)); await writer.retainPath(view.mainId);
    await writeFile(join(directory, 'session.json'), JSON.stringify(session.checkpoint()));
    const foreign = join(root, 'runs', 'f'.repeat(64));
    await openDoomEvaluationRecording(foreign);
    const foreignBefore = await readFile(join(foreign, 'recording.json'), 'utf8');
    await f.evaluator.recover();
    const reader = new LearningEvaluationReader(f.root);
    const recovered = await reader.view(f.request.proposalId, false);
    assert.equal(recovered.runs[0]!.status, 'interrupted');
    assert.equal(recovered.runs[0]!.replay!.frames, 1); assert.equal(recovered.runs[0]!.replay!.incomplete, true);
    assert.equal((await reader.replayFrames(f.request.proposalId, id, 0, 1))[0]!.tick, view.worlds[0]!.state.tick);
    await assert.rejects(readFile(join(directory, 'result.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(foreign, 'recording.json'), 'utf8'), foreignBefore);
    assert.equal(f.calls, 0); assert.equal(f.creations, 0);
    await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal), /already admitted/);
  } finally { await session.close(); await f.cleanup(); }
});

test('sized allowance lets both sides complete a fork and pins the concrete contract in a versioned manifest', async () => {
  const f = await fixture(true);
  try {
    const result = await f.evaluator.qualify(f.request, new AbortController().signal);
    assert.equal(result.accepted, false, 'equal outcomes still cannot qualify');
    const directory = join(f.root, f.request.proposalId);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(directory, 'comparison.json'), 'utf8'));
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.templateContract, f.options.contract);
    assert.equal(manifest.contract.budget.limits.simulation, 112); // 35 init + 7 setup + 2 x 35 trial.
    assert.notDeepEqual(manifest.evaluationRequest.contract, manifest.request.contract);
    assert.deepEqual(report.runs.map((run: any) => run.status), ['complete', 'complete']);
    for (const run of report.runs) {
      assert.deepEqual(run.budget.spec, manifest.contract.budget);
      assert.ok(run.evidence.session.stats.seconds - run.evidence.initialStats.seconds >= 1);
      assert.ok(run.evidence.session.worlds.some((world: any) => world.role === 'archived'));
      const recording = await recordingFor(f.root, f.request.proposalId, run.id);
      assert.equal(recording.path!.missingHistory, false);
      assert.ok(recording.path!.segments.length > 1, 'selected replay must include the parent and winning future');
      assert.equal(recording.path!.frames, run.evidence.final.tick - run.evidence.initial.tick + 1);
    }
    assert.deepEqual(result.contract, f.request.contract);
    await new DoomVmEvaluations(f.options).recover();
    await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal), /already admitted/);
  } finally { await f.cleanup(); }
});

test('changed contracts and stale user guides are refused before allocating game worlds or calling models', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.evaluator.qualify({ ...f.request, contract: { id: 'different', version: '1' } }, new AbortController().signal), /contract changed/);
    f.changeContext(); await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal), /user context changed/);
    assert.equal(f.calls, 0); assert.equal(f.creations, 0);
  } finally { await f.cleanup(); }
});

test('cancellation produces incomplete evidence and cleans worlds/checkpoints before returning', async () => {
  const f = await fixture(), control = new AbortController();
  try {
    f.hooks.decide = async () => { control.abort(new Error('Cancelled fixture')); };
    const result = await f.evaluator.qualify(f.request, control.signal); assert.equal(result.accepted, false);
    const report = JSON.parse(await readFile(join(f.root, f.request.proposalId, 'comparison.json'), 'utf8'));
    assert.equal(report.runs.length, 1); assert.equal(report.runs[0].status, 'cancelled');
    assert.equal(f.points.size, 0); assert.ok([...f.worlds.values()].every(world => world.destroyed));
    assert.equal(f.calls, 1);
    const recording = await recordingFor(f.root, f.request.proposalId, report.runs[0].id);
    assert.equal(recording.path!.frames, 1, 'cancelled before the first action: retain the actual starting frame only');
  } finally { await f.cleanup(); }
});


test('a retained live checkpoint adds a paired case, persists both contract identities and remains borrowed', async () => {
  const f = await fixture();
  try {
    const ref = `mom-checkpoint-${f.request.proposalId}:recovery`;
    const source = new Runtime('stuck-source'); await source.step({ inputs: [], ticks: 1000 });
    const state = await source.state(); f.points.set(ref, state);
    const incident = doomIncidentCheckpoint(ref, 'physical-' + ref, state);
    const sourceSession = new Session({ decide: async () => decision }); await sourceSession.initialize(source);
    const continuation = sessionContinuation(sourceSession.checkpoint());
    continuation.stats!.ticks = 7000; continuation.stats!.lastProgressTick = 0;
    continuation.stats!.visited.push('1:1:5:5:0');
    const result = await f.evaluator.qualify(f.request, new AbortController().signal, incident, continuation);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.contract, f.request.contract);
    const manifest = JSON.parse(await readFile(join(f.root, f.request.proposalId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.templateContract, f.options.contract);
    assert.equal(manifest.contract.scenarios.length, 2);
    assert.notDeepEqual(manifest.evaluationRequest.contract, manifest.request.contract);
    const report = JSON.parse(await readFile(join(f.root, f.request.proposalId, 'comparison.json'), 'utf8'));
    const runs = report.runs.filter((run: any) => run.scenarioId === 'saved-stuck-position');
    assert.equal(runs.length, 2);
    // The fixture budget intentionally cannot satisfy the 210-tick incident coverage gate.
    assert.ok(runs.every((run: any) => run.status === 'error' && /Insufficient selected gameplay/.test(run.error)));
    assert.equal(f.creations, 0, 'failed incident coverage skips all remaining opening cases');
    assert.equal(report.runs.length, 2);
    assert.match(result.reason, /remaining test games were skipped/);
    assert.deepEqual(f.points.get(ref), state, 'borrowed checkpoint survives evaluator cleanup');
    assert.equal(f.points.size, 1);
  } finally { await f.cleanup(); }
});

test('selected practice is recorded and replayable but cannot qualify a rejected acceptance comparison', async () => {
  const f = await fixture();
  try {
    const catalog = doomTrainingCatalog(f.options.contract);
    const selection = { catalog: catalog.revision, scenarioIds: ['opening'], reason: 'Check opening priorities' };
    const before = structuredClone(f.options.contract);
    const pending = f.evaluator.qualify(f.request, new AbortController().signal, undefined, undefined, selection);
    selection.scenarioIds[0] = 'mutated-after-dispatch';
    const result = await pending;
    selection.scenarioIds[0] = 'opening';
    assert.equal(result.accepted, false); assert.match(result.reason, /mean improvement/);
    assert.deepEqual(f.options.contract, before); assert.deepEqual(result.contract, f.request.contract);
    const root = join(f.root, f.request.proposalId);
    const practice = JSON.parse(await readFile(join(root, 'training-result.json'), 'utf8'));
    assert.equal(practice.purpose, 'practice'); assert.equal(practice.comparison.accepted, true);
    assert.ok(practice.comparison.runs.every((run: any) => run.status === 'complete'));
    const acceptance = JSON.parse(await readFile(join(root, 'comparison.json'), 'utf8'));
    assert.deepEqual(acceptance.contract, before); assert.deepEqual(acceptance.gains.map((pair: any) => pair.scenarioId), ['first']);
    const evidence = result.evidence as any;
    assert.deepEqual(evidence.training.reference, contentRevision('doom-training-result', practice));
    assert.equal(evidence.training.feedback.purpose, 'practice'); assert.equal(evidence.training.feedback.accepted, undefined);
    assert.deepEqual(evidence.training.feedback.results, [{ scenarioId: 'opening', complete: true, gain: 0 }]);
    const reader = new LearningEvaluationReader(f.root), view = await reader.view(f.request.proposalId, false);
    assert.equal(view.total, 4); assert.equal(view.finished, 4);
    const run = view.runs.find(run => run.purpose === 'practice')!;
    assert.equal(run.scenarioId, 'practice/opening'); assert.ok(run.replay?.frames);
    assert.equal((await reader.replayFrames(f.request.proposalId, run.id, 0, 1)).length, 1);
    assert.ok(reader.frame(run.worlds[0]!.frame!));
    assert.equal(f.points.size, 0); assert.ok([...f.worlds.values()].every(world => world.destroyed));
    const calls = f.calls;
    const reopened = new DoomVmEvaluations(f.options); await reopened.recover();
    await assert.rejects(reopened.qualify(f.request, new AbortController().signal, undefined, undefined, selection), /already admitted/);
    assert.equal(f.calls, calls);
  } finally { await f.cleanup(); }
});

test('practice rejects stale selections before dispatch and excludes acceptance setups from its public menu', async () => {
  const f = await fixture();
  try {
    const acceptance = { ...f.options.contract, scenarios: [{ id: 'private', seed: 'secret', input: { setup: [] } }] };
    const catalog = doomTrainingCatalog(acceptance), menu = trainingMenu(catalog);
    assert.equal(menu.scenarios.some(scenario => scenario.id === 'opening'), false);
    assert.equal(JSON.stringify(menu).includes('secret'), false); assert.equal(JSON.stringify(menu).includes('setup'), false);
    const selection = { catalog: catalog.revision, scenarioIds: ['left-facing'], reason: 'Check orientation' };
    assert.equal(doomTrainingContract(acceptance, selection).scenarios[0]!.id, 'left-facing');
    await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal, undefined, undefined, selection), /Invalid or stale/);
    const current = doomTrainingCatalog(f.options.contract);
    await assert.rejects(f.evaluator.qualify(f.request, new AbortController().signal, undefined, undefined,
      { ...selection, catalog: current.revision, scenarioIds: ['private'] }), /Invalid or stale/);
    assert.equal(f.calls, 0); assert.equal(f.creations, 0);
  } finally { await f.cleanup(); }
});

test('cancelled or stale practice never starts acceptance, and restart cannot repeat its paid work', async () => {
  for (const mode of ['cancel', 'stale'] as const) {
    const f = await fixture(), control = new AbortController();
    try {
      const selection = { catalog: doomTrainingCatalog(f.options.contract).revision, scenarioIds: ['opening'], reason: 'Check initial choices' };
      f.hooks.decide = async () => { if (mode === 'cancel') control.abort(new Error('Stop practice')); else f.changeContext(); };
      await assert.rejects(f.evaluator.qualify(f.request, control.signal, undefined, undefined, selection), mode === 'cancel' ? /Stop practice/ : /context changed during practice/);
      await assert.rejects(readFile(join(f.root, f.request.proposalId, 'resources.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(f.root, f.request.proposalId, 'comparison.json')), { code: 'ENOENT' });
      const calls = f.calls; await new DoomVmEvaluations(f.options).recover();
      assert.equal(f.calls, calls); assert.equal(f.points.size, 0); assert.ok([...f.worlds.values()].every(world => world.destroyed));
      const view = await new LearningEvaluationReader(f.root).view(f.request.proposalId, false);
      assert.ok(view.runs.some(run => run.purpose === 'practice' && run.status !== 'not-run'));
      assert.ok(view.runs.filter(run => !run.purpose).every(run => run.status === 'not-run'));
    } finally { await f.cleanup(); }
  }
});

test('startup finds and releases abandoned practice resources without restarting their games', async () => {
  const f = await fixture();
  try {
    const store = new JsonFileStore(join(f.root, 'practice', f.request.proposalId, 'resources.json'), decodeDoomEvaluationVms);
    const owner = await DoomEvaluationVms.open(store, f.options.runtime);
    const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 100 } });
    const world = await owner.create('abandoned-practice', ledger, new AbortController().signal);
    await owner.checkpoints('abandoned-practice').capture(world, `mom-checkpoint-${randomUUID()}:recovery`);
    assert.equal(f.points.size, 1); assert.equal(f.calls, 0);
    const creations = f.creations;
    await new DoomVmEvaluations(f.options).recover();
    assert.equal(f.creations, creations); assert.equal(f.calls, 0); assert.equal(f.points.size, 0);
    assert.ok([...f.worlds.values()].every(world => world.destroyed));
    assert.ok((await store.load())!.runs.every(run => run.closed && run.worlds.every(world => world.released)));
  } finally { await f.cleanup(); }
});
