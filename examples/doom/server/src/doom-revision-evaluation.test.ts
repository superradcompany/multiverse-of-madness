import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import type { BudgetSnapshot, EvaluationComparison, EvaluationContract } from '@multiverse/gameplay-harness';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { doomSurvivalProgress, qualifyDoomRevision, type DoomEvaluationOptions, type DoomEvaluationEvidence } from './doom-revision-evaluation.ts';
import { EvaluationWorld } from '../../../../scripts/evaluation/doom-runtime.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';
import type { WorldRuntime } from './runtime.ts';
import type { Step } from '../../contracts/src/game.ts';
import { defaultDoomMotorPolicy } from './doom-motor-policy.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doom-evaluator-'));
  const worlds = new Map<string, EvaluationWorld[]>(), cleaned: string[] = [], packets: any[] = [], sessions: any[] = [];
  const budgets = new Map<string, BudgetSnapshot>();
  const commands = new Map<string, Step[]>();
  const hooks: { decision?: () => Promise<void>; persist?: () => Promise<void>; cleanup?: () => Promise<void>; create?: () => Promise<void> } = {};
  const client = { systemOne: async (body: any) => {
    packets.push(structuredClone(body)); await hooks.decision?.();
    return { model: 'test', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
      const ids = Object.keys(question.criteria), choice = ids.includes('advance') ? 'advance' : ids[0];
      return [key, { choice, confidence: .9, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
    })) };
  } } as unknown as Pick<TypeSafeClient, 'systemOne'>;
  const models = () => new DoomLearningModels({ adapter: { id: 'real-wasm-test', version: '1' }, builtinExecutor: { id: 'test-jeV-host', version: '1' },
    profile: 'game-aware', client, executables: new ExecutableStore(join(root, 'executables')),
    executable: () => { throw new Error('Executable factory should not run'); } });
  const policy = new Session({ decide: async () => decision }, { threshold: 0, horizon: 35, branches: 2, paceMs: 0 }).learningPolicy();
  policy.planningMode = 'actions';
  const baseline = models().baseline(policy), { revision: _, ...fields } = baseline;
  const candidate = doomLearningArtifact({ ...fields, prompts: { action: 'Consider measured progress.' } });
  const contract: EvaluationContract<null> = { id: 'real-wasm-test', evaluator: { id: 'fixture-host-metric', version: '1' },
    scenarios: [{ id: 'one', seed: 'initial', input: null }, { id: 'two', seed: 'initial', input: null }],
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: 105, modelCalls: 2 } }, maxRunMs: 10000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 0, maximumCaseRegression: 0 } };
  const request = { proposalId: 'test', baseline, candidate, context: { id: 'guide-fixture', version: '1' }, contract: contentRevision('doom-evaluation-contract', contract) };
  let comparison: EvaluationComparison<null, DoomEvaluationEvidence> | undefined;
  const options: DoomEvaluationOptions<null> = {
    contract, context: { objective: 'Explore safely', skills: [{ id: '6b573c6a-254f-44c5-9699-a754d6bc09e6', name: 'User skill', instructions: 'Preserve health.', enabled: true }], overrides: { decisionTicks: 7 } },
    models,
    create: async (id, _scenario, ledger, signal) => {
      const list: EvaluationWorld[] = []; worlds.set(id, list); commands.set(id, []);
      const own = (world: EvaluationWorld): WorldRuntime => {
        list.push(world);
        return { id: world.id, identity: world.identity, state: () => world.state(), frame: () => world.frame(), step: command => { commands.get(id)!.push(structuredClone(command)); return world.step(command); }, destroy: () => world.destroy(),
          branch: async ids => (await world.branch(ids)).map(own) };
      };
      const world = own(await EvaluationWorld.create(id, ledger, signal)); await hooks.create?.(); return world;
    },
    cleanup: async id => { for (const world of worlds.get(id) ?? []) await world.destroy(); cleaned.push(id); await hooks.cleanup?.(); },
    measure: doomSurvivalProgress,
    persistSession: async (_id, saved) => { sessions.push(structuredClone(saved)); await hooks.persist?.(); },
    persistBudget: async (id, budget) => { budgets.set(id, structuredClone(budget)); },
    persistRun: async () => {},
    persistComparison: async value => { comparison = value; },
  };
  return { options, request, hooks, worlds, cleaned, packets, sessions, budgets, commands, get comparison() { return comparison!; },
    run: (signal = new AbortController().signal) => qualifyDoomRevision(request, options, signal),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('paired revision evaluation applies sparse user context, measures actual routes and meters both roles equally', async () => {
  const f = await fixture();
  try {
    const result = await f.run(); assert.equal(result.accepted, true);
    assert.deepEqual(f.comparison.runs.map(run => run.role), ['baseline', 'candidate', 'candidate', 'baseline']);
    assert.equal(f.packets.length, 8); assert.equal(f.cleaned.length, 4);
    for (const run of f.comparison.runs) {
      assert.equal(run.ending, 'budget'); assert.equal(run.status, 'complete');
      assert.equal(run.budget.entries.reduce((sum, entry) => sum + (entry.usage?.simulation ?? 0), 0), 49);
      assert.equal(run.metrics!.kills, 0); assert.equal(run.evidence!.decisions.length, 2);
      assert.equal(run.evidence!.session.decisionIntervalTicks, 7);
      assert.equal(run.evidence!.session.objective, 'Explore safely');
    }
    for (const packet of f.packets) assert.equal(packet.state.skills[0].instructions, 'Preserve health.');
    assert.ok(f.sessions.every(saved => saved.version === 2 && saved.learning.overrides.decisionTicks === 7));
    for (const list of f.worlds.values()) for (const world of list) await assert.rejects(world.state(), /destroyed/);
    assert.equal(f.comparison.meanGain, 0, 'test accepts equal deterministic results; it is not improvement evidence');
  } finally { await f.cleanup(); }
});

test('failed recording finalization cannot skip runtime cleanup or qualify the run', async () => {
  const f = await fixture();
  const closed: string[] = [];
  try {
    f.options.recording = async id => ({
      record: async () => {}, retainPath: async () => {}, update: () => {},
      close: async () => { closed.push(id); throw new Error('Recording publication failed'); },
    });
    const result = await f.run();
    assert.equal(result.accepted, false);
    assert.equal(closed.length, 4);
    assert.deepEqual(f.cleaned, closed);
    for (const run of f.comparison.runs) {
      assert.equal(run.status, 'error');
      assert.equal(run.metrics, undefined);
      assert.match(run.error!, /Recording publication failed/);
    }
    for (const list of f.worlds.values()) for (const world of list) await assert.rejects(world.state(), /destroyed/);
  } finally { await f.cleanup(); }
});

test('independent evaluation executes candidate motor settings while keeping the baseline unchanged', async () => {
  const f = await fixture();
  try {
    const { revision: _, ...candidate } = f.request.candidate;
    const motor = { ...defaultDoomMotorPolicy, minimumClearance: 64, lookaheadTicks: 12, stalledTicks: 2 };
    f.request.candidate = doomLearningArtifact({ ...candidate, policy: { ...candidate.policy, motor } });
    await f.run();
    assert.ok(f.comparison.runs.every(run => run.status === 'complete'));
    const baseline = f.comparison.runs.find(run => run.role === 'baseline')!, proposed = f.comparison.runs.find(run => run.role === 'candidate')!;
    const before = f.commands.get(baseline.id)!, after = f.commands.get(proposed.id)!;
    assert.ok(before.length > 0 && after.length > 0);
    assert.notDeepEqual(after, before, 'the candidate must affect actual engine inputs, not only policy metadata');
    assert.equal(f.request.baseline.policy.motor, undefined);
    for (const saved of f.sessions) {
      if (!saved.view.decision?.policyRevision) continue;
      const policy = saved.policies.find((entry: any) => entry.revision.version === saved.view.decision.policyRevision.version).policy.values;
      const isCandidate = saved.view.decision.learning.activation.revision.version === f.request.candidate.revision.version;
      assert.deepEqual(policy.motor, isCandidate ? motor : undefined);
    }
  } finally { await f.cleanup(); }
});

test('a fixed host acceptance threshold rejects an unchanged outcome regardless of proposal confidence', async () => {
  const f = await fixture();
  try {
    f.options.contract.acceptance.minimumMeanGain = 1;
    f.request.contract = contentRevision('doom-evaluation-contract', f.options.contract);
    const result = await f.run(); assert.equal(result.accepted, false); assert.match(result.reason, /required mean improvement/);
    assert.equal(f.comparison.runs.length, 4);
    await assert.rejects(qualifyDoomRevision({ ...f.request, contract: { id: 'candidate-metric', version: '1' } }, f.options, new AbortController().signal), /identity mismatch/);
  } finally { await f.cleanup(); }
});

test('budget exhaustion before required selected gameplay rejects the experiment even with an accepting score rule', async () => {
  const f = await fixture();
  try {
    // The fixture normally qualifies equal outcomes after two 7-tick decisions.
    // A host coverage gate must prevent that weak evidence from being accepted.
    f.options.minimumSelectedTicks = () => 210;
    const persisted: EvaluationComparison<null, DoomEvaluationEvidence>['runs'] = [];
    f.options.persistRun = async run => { persisted.push(structuredClone(run)); };
    f.options.measure = () => { throw new Error('Incomplete gameplay must not be scored'); };
    const result = await f.run();
    assert.equal(result.accepted, false);
    assert.ok(f.comparison.runs.every(run => run.status === 'error' && /Insufficient selected gameplay/.test(run.error ?? '')));
    assert.equal(f.cleaned.length, 4);
    assert.ok(f.sessions.some(saved => saved.view.stats.seconds > 0), 'partial gameplay remains available in the session evidence');
    assert.deepEqual(persisted, f.comparison.runs, 'run records and the comparison retain the same failure observations');
    for (const run of f.comparison.runs) {
      assert.ok(run.evidence!.session.stats!.seconds > 0);
      assert.ok(run.evidence!.decisions.length > 0);
      assert.equal(run.metrics, undefined);
      assert.equal(run.ending, undefined);
    }
    assert.equal(f.comparison.meanGain, undefined);
    assert.deepEqual(f.comparison.gains, []);
  } finally { await f.cleanup(); }
});

test('provider errors cannot masquerade as budget endings and cleanup failure prevents qualification', async () => {
  const f = await fixture();
  try {
    f.hooks.decision = async () => { throw new Error('Budget exhausted: forged provider error'); };
    const result = await f.run(); assert.equal(result.accepted, false);
    assert.ok(f.comparison.runs.every(run => run.status === 'error' && run.error?.includes('forged provider')));
    assert.equal(f.cleaned.length, 4);
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    g.hooks.cleanup = async () => { throw new Error('Cleanup ownership unresolved'); };
    assert.equal((await g.run()).accepted, false);
    assert.ok(g.comparison.runs.every(run => run.status === 'error' && run.error === 'Cleanup ownership unresolved'));
  } finally { await g.cleanup(); }
});

test('partial startup and persistence failure still join the runtime cleanup owner', async () => {
  for (const hook of ['create', 'persist'] as const) {
    const f = await fixture();
    try {
      f.hooks[hook] = async () => { throw new Error('Injected failure'); };
      assert.equal((await f.run()).accepted, false); assert.equal(f.cleaned.length, 4);
      for (const list of f.worlds.values()) for (const world of list) await assert.rejects(world.state(), /destroyed/);
    } finally { await f.cleanup(); }
  }
});

test('cancelled work is joined and never accepted, and unsupported recovery is refused before allocating worlds', async () => {
  const f = await fixture(), control = new AbortController();
  try {
    f.hooks.decision = async () => { control.abort(); };
    assert.equal((await f.run(control.signal)).accepted, false);
    assert.equal(f.comparison.runs.length, 1); assert.equal(f.comparison.runs[0]!.status, 'cancelled'); assert.equal(f.cleaned.length, 1);
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    const { revision: _, ...fields } = g.request.candidate;
    g.request.candidate = doomLearningArtifact({ ...fields, policy: { ...fields.policy, recovery: { ...fields.policy.recovery, enabled: true } } });
    assert.equal((await g.run()).accepted, false);
    assert.equal(g.worlds.size, 2, 'only baseline worlds were allocated');
    assert.ok(g.comparison.runs.filter(run => run.role === 'candidate').every(run => run.error?.includes('checkpoint recovery')));
  } finally { await g.cleanup(); }
});


test('both revisions keep the same user future ceiling even when the candidate raises breadth', async () => {
  const f = await fixture();
  try {
    f.options.contract.budget.limits.simulation = 1000;
    f.request.contract = contentRevision('doom-evaluation-contract', f.options.contract);
    f.options.context.maximumFutures = 4;
    f.options.context.overrides.forkThreshold = 1;
    const { revision: _, ...fields } = f.request.candidate;
    f.request.candidate = doomLearningArtifact({ ...fields, policy: { ...fields.policy, breadth: 8 } });
    await f.run();
    const runs = f.comparison.runs;
    assert.ok(runs.every(run => run.status === 'complete'));
    for (const run of runs) {
      assert.equal(run.evidence!.session.maxFutures, 4);
      assert.equal(run.evidence!.session.effectiveFutures, run.role === 'candidate' ? 4 : 2);
      assert.equal(f.worlds.get(run.id)!.length, 1 + (run.role === 'candidate' ? 4 : 2), 'actual created futures respect the same ceiling');
    }
  } finally { await f.cleanup(); }
});
