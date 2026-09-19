import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetLedger, type SupervisorReceipt, type SupervisorOutput } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomSupervisor, decodeDoomSupervisor } from './doom-supervisor.ts';
import { DoomLearningModels } from './doom-learning-models.ts';
import { candidatePlans } from './doom-plans.ts';
import { geometryFor } from './doom-geometry.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { decodeDoomProposal, doomSupervisorEvidence, generateDoomProposal, type DoomProposalOptions, type DoomProposalRecord } from './doom-supervisor-proposal.ts';
import { defaultDoomExecutionPolicy } from './doom-execution-policy.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const guidance = { kind: 'guidance', reason: 'Reduce repeated unproductive movement', prompts: { plan: 'Use measured progress before repeating a waypoint.' } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doom-proposal-')), id = randomUUID();
  const hooks: { result?: () => Promise<unknown>; persist?: (record: DoomProposalRecord) => Promise<void>; cost?: number; usage?: SupervisorReceipt['usage']; status?: SupervisorReceipt['status']; throwValue?: () => unknown; qualify?: Parameters<typeof DoomSupervisor.open>[0]['qualify'] } = {};
  const session = new Session({ decide: async () => structuredClone(decision) });
  await session.initialize(new Runtime('root')); session.setPersistence(async () => {});
  const executables = new ExecutableStore(join(root, 'sources'));
  const models = new DoomLearningModels({ adapter: { id: 'test-adapter', version: '1' }, builtinExecutor: { id: 'test-host', version: '1' },
    profile: 'game-aware', executables, executable: () => { throw new Error('Generation cannot execute candidate source'); } });
  const journal = new JsonFileStore(join(root, 'supervisor.json'), decodeDoomSupervisor);
  const ownerOptions = { store: journal, models, initial: models.baseline(session.learningPolicy()),
    rules: { contract: { id: 'private-acceptance-suite', version: '1' }, capabilities: ['policy', 'prompts', 'skills', 'executor', 'model'] as Array<'policy' | 'prompts' | 'skills' | 'executor' | 'model'>, maxLifetimeMs: 60000 },
    qualify: ((request, signal) => { if (hooks.qualify) return hooks.qualify(request, signal); throw new Error('Generation must not invoke the evaluator'); }) as Parameters<typeof DoomSupervisor.open>[0]['qualify'] };
  let supervisor = await DoomSupervisor.open(ownerOptions); await supervisor.adopt(session);
  const disk = new JsonFileStore(join(root, 'job.json'), decodeDoomProposal);

  const budgetStore = new JsonFileStore(join(root, 'budget.json'), value => value);
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { supervisorCalls: 1, costMicros: 1000, simulation: 0 } }, value => budgetStore.save(value));
  let calls = 0;
  const provider: DoomProposalOptions['provider'] = { version: { id: 'fixture-provider', version: '1' }, propose: async request => {
    calls++;
    const draft = await (hooks.result?.() ?? Promise.resolve(guidance));
    if (hooks.throwValue) throw hooks.throwValue();
    return { draft, receipt: { id: request.id, provider: provider.version, startedAt: Date.now(), elapsedMs: 1,
      inputBytes: 100, outputBytes: 100, requestedModel: 'fixture', servingModels: ['fixture'],
      status: hooks.status ?? 'complete', usage: hooks.usage ?? { inputTokens: 12, outputTokens: 4, costMicros: hooks.cost ?? 123 } } };
  } };
  const store = { load: () => disk.load(), save: async (record: DoomProposalRecord) => { await disk.save(record); await hooks.persist?.(record); }, flush: () => disk.flush() };
  const options: DoomProposalOptions = { id, supervisor, models, executables, provider, ledger, limits: { timeoutMs: 1000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 1000 }, store, capture: () => session.checkpoint() };
  return { root, session, journal, disk, ledger, hooks, options, get calls() { return calls; }, get supervisor() { return supervisor; },
    run: (signal = new AbortController().signal) => generateDoomProposal(options, signal),
    reopen: async () => { supervisor = await DoomSupervisor.open({ ...ownerOptions, expectedBinding: supervisor.binding.identity }); options.supervisor = supervisor; },
    cleanup: async () => { await supervisor.close(); await ledger.join(); await rm(root, { recursive: true, force: true }); } };
}

test('generation freezes observed evidence, accounts actual usage and submits without evaluating or activating', async () => {
  const f = await fixture();
  try {
    const before = f.session.checkpoint();
    const result = await f.run();
    assert.equal(result.status, 'submitted'); assert.equal(f.calls, 1);
    assert.equal(f.ledger.used('costMicros'), 123); assert.equal(f.ledger.used('supervisorCalls'), 1);
    assert.equal(f.ledger.used('inputTokens'), 12);
    const journal = f.supervisor.snapshot().journal;
    assert.equal(journal.active.epoch, 0); assert.equal(journal.proposals[0]!.status, 'proposed');
    assert.deepEqual(f.session.checkpoint(), before);
    assert.deepEqual(result.request.current, journal.artifacts[0]);
    assert.deepEqual(result.output, guidance);
    assert.deepEqual((await f.run()).candidate, result.candidate); assert.equal(f.calls, 1);
    assert.equal(JSON.stringify(result.request).includes('acceptance: '), false);
  } finally { await f.cleanup(); }
});

test('supervisor execution settings become a candidate artifact without changing the running policy', async () => {
  const f = await fixture();
  try {
    const original = f.session.learningPolicy();
    const execution = { ...defaultDoomExecutionPolicy, blockedAfterTicks: 14, damageBeforeReplan: 4 };
    f.hooks.result = async () => ({ kind: 'guidance', reason: 'Reconsider movement earlier after observed blocked routes', policy: { ...original, execution } });
    const result = await f.run();
    assert.equal(result.status, 'submitted');
    assert.deepEqual(result.candidate!.policy.execution, execution);
    assert.deepEqual(f.session.learningPolicy(), original);
    await f.reopen();
    assert.deepEqual((await f.run()).candidate!.policy.execution, execution);
    assert.equal(f.calls, 1);
  } finally { await f.cleanup(); }
});

test('source proposals are stored unchanged but never imported, executed, evaluated or activated during generation', async () => {
  const f = await fixture();
  try {
    const source = { format: 1 as const, runtime: 'node-typescript' as const, entrypoint: 'main.ts',
      files: { 'main.ts': 'throw new Error("must not run during generation"); export default input => input;' } };
    f.hooks.result = async () => ({ kind: 'executor', reason: 'A source proposal', source });
    const result = await f.run(); assert.equal(result.status, 'submitted');
    assert.deepEqual((await f.options.executables.get(result.candidate!.executor)).source, source);
    assert.deepEqual(result.candidate!.model, { id: 'isolated-doom-ranking', version: '1' });
    assert.equal(f.supervisor.snapshot().journal.active.epoch, 0);
  } finally { await f.cleanup(); }
});

test('token-only receipts retain known tokens while leaving uncapped price unknown and bounded reservations conservative', async () => {
  for (const unrestricted of [false, true]) {
    const f = await fixture();
    try {
      f.options.unrestricted = unrestricted;
      if (unrestricted) f.options.ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: {} });
      f.hooks.usage = { inputTokens: 25_851, outputTokens: 446, cachedInputTokens: 20_000 };
      const result = await f.run();
      assert.equal(result.status, 'submitted', result.error);
      assert.equal(result.receipt!.usage!.costMicros, undefined);
      const saved = f.options.ledger.snapshot();
      assert.equal(saved.entries[0]!.usage!.inputTokens, 25_851);
      assert.equal(saved.entries[0]!.usage!.outputTokens, 446);
      assert.equal(saved.entries[0]!.usage!.costMicros, unrestricted ? undefined : 1000);
      const restored = new BudgetLedger(saved.spec, undefined, saved);
      assert.equal(restored.used('inputTokens'), 25_851);
      await f.run(); assert.equal(f.calls, 1);
    } finally { await f.cleanup(); }
  }
});

test('strategic guidance omits code-generation context while retaining current stats and the user objective', async () => {
  const compact = await fixture(), full = await fixture();
  try {
    compact.options.kind = 'guidance';
    const guidanceResult = await compact.run(), fullResult = await full.run();
    assert.equal(guidanceResult.status, 'submitted');
    const request = guidanceResult.request;
    assert.match(request.task, /Jev owns frequent execution/);
    assert.match(request.task, /Each prompt is at most 1024 characters/);
    assert.match(request.task, /2048 UTF-8 JSON bytes/);
    assert.match(request.task, /at most 8 unique skills/);
    assert.doesNotMatch(request.task, /doom-preparation\/1|Executor source is deterministic/);
    assert.equal(request.evidence.preparationExample, undefined);
    assert.equal(request.evidence.preparationOutputSchema, undefined);
    assert.equal(request.evidence.currentSource, undefined);
    assert.equal(request.objective, compact.session.snapshot().objective);
    assert.deepEqual(request.evidence.observations.main, fullResult.request.evidence.observations.main);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < Buffer.byteLength(JSON.stringify(fullResult.request)), 'guidance should send less context than a code-capable request');
    assert.equal((request.outputSchema as any).properties.kind.const, 'guidance');
    const schema = request.outputSchema as any;
    assert.equal(schema.properties.prompts.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties.prompts.properties).sort(), ['action', 'guide', 'plan', 'priority']);
    for (const slot of Object.values(schema.properties.prompts.properties) as any[]) assert.equal(slot.maxLength, 1024);
    assert.equal(schema.properties.skills.maxItems, 8);
    assert.equal(schema.properties.skills.items.properties.instructions.maxLength, 1024);
  } finally { await compact.cleanup(); await full.cleanup(); }
});

test('guidance generation honors the advertised boundary without truncation or a duplicate request', async () => {
  for (const length of [1024, 1025]) {
    const f = await fixture();
    try {
      f.options.kind = 'guidance';
      const guide = 'x'.repeat(length);
      f.hooks.result = async () => ({ ...guidance, prompts: { guide } });
      const result = await f.run();
      assert.equal(result.status, length === 1024 ? 'submitted' : 'failed');
      assert.deepEqual(result.output, { ...guidance, prompts: { guide } });
      if (length === 1024) assert.equal(result.candidate!.prompts.guide, guide);
      else { assert.match(result.error!, /1024/); assert.equal(f.supervisor.snapshot().journal.proposals.length, 0); }
      await f.reopen(); assert.equal((await f.run()).status, result.status); assert.equal(f.calls, 1);
    } finally { await f.cleanup(); }
  }
});

test('aggregate UTF-8 guidance limits remain enforced even when individual fields fit', async () => {
  const f = await fixture();
  try {
    f.options.kind = 'guidance';
    f.hooks.result = async () => ({ ...guidance, prompts: { guide: '界'.repeat(700) } });
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.match(result.error!, /2048-byte/);
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
  } finally { await f.cleanup(); }
});

test('planner proposals preserve their source and select the preparation-plus-Jev ABI without executing it', async () => {
  const f = await fixture();
  try {
    const source = { format: 1 as const, runtime: 'node-typescript' as const, entrypoint: 'main.ts', files: {
      'main.ts': 'export default input => ({abi:"doom-preparation/1",historyIndices:[],experienceIndices:[],features:{}});',
    } };
    f.options.kind = 'planner';
    f.session.setTrialDuration(2100);
    f.session.setDecisionInterval(70);
    f.session.setDecisionIntervalMode('trial');
    f.hooks.result = async () => ({ kind: 'planner', reason: 'Generate routes and select useful context', source, model: 'jev-1.13.0' });
    const result = await f.run(); assert.equal(result.status, 'submitted', result.error);
    assert.deepEqual((await f.options.executables.get(result.candidate!.executor)).source, source);
    assert.deepEqual(result.candidate!.model, { id: 'prepared-doom-jev', version: 'jev-1.13.0' });
    assert.equal(result.request.evidence.requestedKind, 'planner');
    const example = result.request.evidence.preparationExample as any;
    assert.deepEqual(example.state, f.session.snapshot().worlds[0]!.state);
    assert.equal(example.state.player, undefined);
    assert.equal(example.abi, 'doom-preparation/1');
    assert.equal(example.actionTicks, 2100, 'planner example uses linked timing, not the stored fixed interval');
    assert.equal(example.planTicks, 2100);
    const main = f.session.checkpoint().worlds[0]!;
    const fullMenu = candidatePlans(main.view.state, await geometryFor(main.view.state, true, true), main.stats?.visited, main.pickups);
    assert.ok(fullMenu.length > 2, 'fixture must detect the old two-plan truncation');
    assert.deepEqual(example.defaultPlans.map((plan: { id: string }) => plan.id), fullMenu.map(plan => plan.id));
    assert.deepEqual(example.visited, f.session.checkpoint().worlds[0]!.stats!.visited);
    assert.ok(result.request.evidence.preparationOutputSchema);
    assert.match(result.request.task, /user requested kind=planner/);
    assert.equal((result.request.outputSchema as any).properties.kind.const, 'planner');
    assert.equal((result.request.outputSchema as any).properties.prompts.properties.guide.maxLength, 1024);
    assert.equal((result.request.outputSchema as any).properties.skills.maxItems, 8);
    await f.run(); assert.equal(f.calls, 1);
    f.options.kind = 'guidance';
    await assert.rejects(f.run(), /kind differs/); assert.equal(f.calls, 1);
    assert.equal(f.supervisor.snapshot().journal.active.epoch, 0);
  } finally { await f.cleanup(); }
});

test('guide changes during generation make the returned artifact stale and concurrent dispatch is refused', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.hooks.result = async () => { entered.resolve(); await release.promise; return guidance; };
    const generating = f.run(); await entered.promise;
    await assert.rejects(f.run(), /already running/);
    f.session.queueObjective('Preserve health above all else'); release.resolve();
    const result = await generating; assert.equal(result.status, 'failed'); assert.match(result.error!, /stale/);
    assert.ok(result.candidate); assert.equal(f.calls, 1); assert.equal(f.ledger.used('costMicros'), 123);
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
  } finally { release.resolve(); await f.cleanup(); }
});

test('malformed or over-budget proposals retain raw output and usage without publishing any candidate', async () => {
  for (const [draft, cost] of [[{ ...guidance, objective: 'find the red key' }, 123], [guidance, 1001], [{ ...guidance, prompts: { typo: 'ignored?' } }, 123]] as const) {
    const f = await fixture();
    try {
      f.hooks.result = async () => draft; f.hooks.cost = cost;
      const result = await f.run(); assert.equal(result.status, 'failed'); assert.deepEqual(result.output, draft);
      assert.equal(f.ledger.used('costMicros'), cost); assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
      await f.run(); assert.equal(f.calls, 1, 'failed proposals are never silently retried');
    } finally { await f.cleanup(); }
  }
});

test('failed and cancelled providers are charged conservatively and cannot publish a late response', async () => {
  const f = await fixture();
  try {
    f.hooks.throwValue = () => undefined;
    const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(f.ledger.used('costMicros'), 1000);
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
  } finally { await f.cleanup(); }
  const g = await fixture(), control = new AbortController();
  try {
    g.hooks.result = async () => { control.abort(); return guidance; };
    const result = await g.run(control.signal); assert.equal(result.status, 'cancelled'); assert.ok(result.output);
    assert.equal(g.ledger.used('costMicros'), 123); assert.equal(g.supervisor.snapshot().journal.proposals.length, 0);
  } finally { await g.cleanup(); }
});

test('restart reconciles a committed proposal after a lost final job acknowledgment without a second provider call', async () => {
  const f = await fixture();
  try {
    f.hooks.persist = async record => { if (record.status === 'submitted') throw new Error('Lost final acknowledgment'); };
    const result = await f.run(); assert.equal(result.status, 'failed');
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 1);
    f.hooks.persist = undefined; await f.reopen();
    const restored = await f.run(); assert.equal(restored.status, 'submitted'); assert.equal(restored.error, undefined); assert.equal(f.calls, 1);
  } finally { await f.cleanup(); }
});

test('an interrupted job is retained without generation/submission and request tampering is refused', async () => {
  const f = await fixture();
  try {
    f.hooks.persist = async record => { if (record.status === 'requested') throw new Error('Host stopped before dispatch'); };
    await assert.rejects(f.run(), /Host stopped/); assert.equal(f.calls, 0);
    f.hooks.persist = undefined; await f.reopen();
    const recovered = await f.run(); assert.equal(recovered.status, 'interrupted'); assert.equal(f.calls, 0);
    const stored = (await f.disk.load())!; stored.request.objective = 'tampered'; await f.disk.save(stored);
    await assert.rejects(f.run(), /content mismatch/); assert.equal(f.calls, 0);
  } finally { await f.cleanup(); }
});

test('supervisor timing follows fixed and linked settings without mutating the saved evidence', async () => {
  const f = await fixture();
  try {
    const saved = f.session.checkpoint();
    const duration = () => (doomSupervisorEvidence(saved).main as any).state.actionDurationSeconds;
    assert.equal(duration(), 1);
    saved.view.decisionIntervalTicks = 70;
    saved.view.trialDurationTicks = 2100;
    saved.view.decisionIntervalMode = 'fixed';
    assert.equal(duration(), 2);
    saved.view.decisionIntervalMode = 'trial';
    assert.equal(duration(), 60);
    const before = structuredClone(saved);
    const full = doomSupervisorEvidence(saved), compact = doomSupervisorEvidence(saved, true);
    assert.deepEqual(compact.timing, full.timing);
    assert.deepEqual(compact.jevDecision, full.jevDecision);
    assert.deepEqual(saved, before, 'the evidence projection does not rewrite historical inputs');
    assert.equal((full.timing as any).trialTicks, 2100);
    assert.equal((full.timing as any).actionTicks, 2100);
  } finally { await f.cleanup(); }
});

test('evidence keeps guide, route statistics and recent observed failures but excludes frames and private runtime state', async () => {
  const f = await fixture();
  try {
    const saved = f.session.checkpoint(), main = saved.worlds[0]!;
    main.frame = 'PRIVATE_FRAME'; main.identity = 'PRIVATE_RUNTIME';
    saved.cleanup = [{ id: 'PRIVATE_CLEANUP', identity: 'secret' }];
    saved.view.commentary.push({ id: 10, worldId: 'root', at: 1, text: 'PRIVATE_COMMENTARY' });
    saved.view.skills = [{ id: 'one', name: 'User skill', instructions: 'Collect health', enabled: true }, { id: 'two', name: 'Off', instructions: 'PRIVATE_DISABLED', enabled: false }];
    const evidence = doomSupervisorEvidence(saved), text = JSON.stringify(evidence);
    assert.doesNotMatch(text, /PRIVATE_/); assert.match(text, /Collect health/);
    assert.deepEqual((evidence.main as any).stats.current.health, main.view.state.health);
    assert.equal((evidence.main as any).state.objective, saved.view.objective);
    const limits = { ...f.options.limits, maxInputBytes: 100 };
    const result = await generateDoomProposal({ ...f.options, limits }, new AbortController().signal);
    assert.equal(result.status, 'failed'); assert.match(result.error!, /input budget/); assert.equal(f.calls, 0);
  } finally { await f.cleanup(); }
});

test('later proposals receive rejected revision settings and aggregate feedback without private acceptance cases', async () => {
  const f = await fixture();
  try {
    const first = await f.run(); assert.equal(first.status, 'submitted');
    f.hooks.qualify = async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision, context: request.context,
      contract: request.contract, accepted: false, reason: 'Regression in PRIVATE_CASE_B', evidence: { meanGain: 26,
        gains: [{ scenarioId: 'PRIVATE_CASE_A', gain: 99 }, { scenarioId: 'PRIVATE_CASE_B', gain: -20 }, { scenarioId: 'PRIVATE_CASE_C', gain: -1 }],
        runs: [{ initialState: 'PRIVATE_ACCEPTANCE_STATE' }] } });
    assert.equal((await f.supervisor.evaluate(first.id)).status, 'rejected');
    const result = await generateDoomProposal({ ...f.options, id: randomUUID(),
      store: new JsonFileStore(join(f.root, 'next-job.json'), decodeDoomProposal),
      ledger: new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { supervisorCalls: 1, costMicros: 1000 } }),
    }, new AbortController().signal);
    const evidence = result.request.evidence.previousExperiments as any[];
    assert.equal(evidence.length, 1); assert.equal(evidence[0].status, 'rejected'); assert.equal(evidence[0].sameUserContext, true);
    assert.deepEqual(evidence[0].settings.prompts, first.candidate!.prompts);
    assert.deepEqual(evidence[0].outcome, { accepted: false, reason: 'Did not pass the host acceptance contract.', meanGain: 26, comparedCases: 3, regressedCases: 2 });
    assert.doesNotMatch(JSON.stringify(result.request), /PRIVATE_CASE|PRIVATE_ACCEPTANCE/);
    assert.equal(f.supervisor.snapshot().journal.active.epoch, 0);
  } finally { await f.cleanup(); }
});


test('a provider cannot substitute guidance for requested planning code or erase its paid response', async () => {
  const f = await fixture();
  try {
    f.options.kind = 'planner';
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.match(result.error!, /instead of requested planner/);
    assert.deepEqual(result.output, guidance); assert.equal(f.ledger.used('costMicros'), 123);
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
    await f.run(); assert.equal(f.calls, 1);
  } finally { await f.cleanup(); }
});


test('subsequent proposals receive useful failure categories without private trial identifiers or states', async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    f.hooks.qualify = async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision,
      context: request.context, contract: request.contract, accepted: false, reason: 'Not every case completed', evidence: { runs: [
        { role: 'baseline', status: 'complete', scenarioId: 'PRIVATE_CASE', evidence: { initial: 'PRIVATE_STATE' } },
        { role: 'candidate', status: 'error', error: 'Trial PRIVATE_WORLD exhausted its idle-transition budget' },
        { role: 'candidate', status: 'error', error: 'Insufficient selected gameplay: 0/210 required ticks; unfinished futures cannot qualify a revision' },
        { role: 'candidate', status: 'error', error: 'PRIVATE_RUNTIME_DETAIL' },
        { scenarioId: 'saved-stuck-position', role: 'candidate', status: 'complete', metrics: { cells: 0, gameSeconds: 36 } },
      ] } });
    await f.supervisor.evaluate(first.id);
    const result = await generateDoomProposal({ ...f.options, id: randomUUID(),
      store: new JsonFileStore(join(f.root, 'next.json'), decodeDoomProposal),
      ledger: new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { supervisorCalls: 1, costMicros: 1000 } }),
    }, new AbortController().signal);
    const outcome = (result.request.evidence.previousExperiments as any[])[0].outcome;
    assert.deepEqual(outcome.execution, { baseline: { complete: 1, failed: 0, failures: {} },
      candidate: { complete: 1, failed: 3, failures: { no_simulation_progress: 1, insufficient_gameplay: 1, other: 1 } } });
    assert.equal(outcome.savedSituation.runs[0].metrics.cells, 0);
    assert.equal(outcome.savedSituation.runs[0].metrics.gameSeconds, 36);
    assert.doesNotMatch(JSON.stringify(result.request), /PRIVATE_/);
  } finally { await f.cleanup(); }
});
