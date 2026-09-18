import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import type { EvaluationContract } from '@multiverse/gameplay-harness';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import { DoomVmEvaluations, type DoomVmScenario } from './doom-vm-evaluations.ts';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { doomSurvivalProgress } from './doom-revision-evaluation.ts';
import { Session, sessionContinuation } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { doomIncidentCheckpoint, type DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';
import type { GameState } from '../../../packages/contracts/src/game.ts';

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
