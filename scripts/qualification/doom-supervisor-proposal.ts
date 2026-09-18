import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore, contentRevision } from '@multiverse/gameplay-harness/node';
import { ClaudeCodeSupervisor, SupervisorFailure } from '../../packages/supervisor-claude/src/provider.ts';
import { DoomSupervisor, decodeDoomSupervisor } from '../../examples/doom/server/src/doom-supervisor.ts';
import { DoomLearningModels } from '../../examples/doom/server/src/doom-learning-models.ts';
import { decodeDoomProposal, doomProposalKindSchema, generateDoomProposal, type DoomProposalEvidence } from '../../examples/doom/server/src/doom-supervisor-proposal.ts';
import { Session } from '../../examples/doom/server/src/session.ts';
import { SessionStore } from '../../examples/doom/server/src/persistence.ts';
import { Jev, type DecisionMaker } from '../../examples/doom/server/src/jev.ts';
import type { DoomPolicy } from '../../examples/doom/server/src/doom-policy.ts';
import { EvaluationWorld } from '../evaluation/doom-runtime.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../../examples/doom/server/src/doom-navigation.ts';

// Real Doom WASM observations and real model requests; no VM forks, independent evaluation or activation.
const kind = doomProposalKindSchema.optional().parse(process.argv.find(arg => arg.startsWith('--kind='))?.slice(7));
const root = resolve('artifacts/doom-supervisor-proposal', new Date().toISOString().replaceAll(':', '-'));
const write = <T>(name: string, value: T) => new JsonFileStore(join(root, name), value => value as T).save(value);
const files = ['examples/doom/server/src/doom-supervisor-proposal.ts', 'examples/doom/server/src/doom-supervisor.ts', 'examples/doom/server/src/doom-learning-models.ts',
  'examples/doom/server/src/jev.ts', 'examples/doom/server/src/jev-learning.ts', 'examples/doom/server/src/session.ts', 'examples/doom/server/src/doom-policy.ts',
  'scripts/evaluation/doom-runtime.ts', 'packages/supervisor-claude/src/provider.ts', 'packages/supervisor-claude/src/process.ts',
  'assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'package-lock.json', import.meta.filename];
const builds = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const control = new AbortController(), abort = () => control.abort(new Error('Qualification interrupted'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
// Manual step compares two futures. Include every child initialization and replay reconstruction, not only winners.
const training = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 385, modelCalls: 2 } }, value => write('training-budget.json', value));
const jev = new Jev();
const model: DecisionMaker = { decide: (...args) => training.run({ owner: 'training', operation: 'jev', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] },
  async () => { const decision = await jev.decide(...args); await write('training-decision-' + training.used('modelCalls') + '.json', decision);
    return { value: decision, usage: { modelCalls: 1, ...decision.usage } }; }, control.signal) };
const session = new Session(model, { threshold: 0, horizon: 35, branches: 2, paceMs: 0 });
session.setPlanningMode('actions'); session.useExperience(true);
session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
const savedLive = await new SessionStore(resolve('.data/session.json')).load();
if (savedLive) session.queueObjective(savedLive.view.pendingObjective ?? savedLive.view.objective);
const store = new SessionStore(join(root, 'session.json')); session.setPersistence(value => store.save(value));
let supervisor: DoomSupervisor | undefined;
try {
  await session.initialize(await EvaluationWorld.create('training-root', training, control.signal));
  for (let i = 0; i < 2; i++) {
    control.signal.throwIfAborted(); session.step(); await session.idle();
    assert.equal(session.snapshot().error, undefined);
    const comparison = session.snapshot().comparison;
    assert.ok(comparison); await session.promote(comparison.bestId);
  }
  await session.pause(); await store.save(session.checkpoint()); await write('training-observations.json', session.checkpoint());
  const executables = new ExecutableStore(join(root, 'executables'));
  const models = new DoomLearningModels({ adapter: contentRevision('doom-proposal-qualification-adapter', builds),
    builtinExecutor: contentRevision('doom-proposal-qualification-host', builds), executables, profile: 'game-aware',
    executable: () => { throw new Error('Generated source must not execute during proposal qualification'); } });
  supervisor = await DoomSupervisor.open({ store: new JsonFileStore(join(root, 'supervisor.json'), decodeDoomSupervisor), models,
    initial: models.baseline(session.learningPolicy()),
    rules: { contract: { id: 'acceptance-not-run', version: '1' }, capabilities: ['policy', 'prompts', 'skills', 'executor', 'model'], maxLifetimeMs: 3600000 },
    qualify: async () => { throw new Error('Independent evaluation is outside this proposal qualification'); } });
  await supervisor.adopt(session);
  const provider = await ClaudeCodeSupervisor.open<DoomPolicy, DoomProposalEvidence>({ effort: 'medium', record: value => write('provider.json', value) });
  const limits = { timeoutMs: 300000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 2000000 };
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { supervisorCalls: 1, costMicros: limits.maxCostMicros, simulation: 0 } }, value => write('proposal-budget.json', value));
  const options = { id: randomUUID(), kind, supervisor, models, executables, provider, limits, ledger,
    store: new JsonFileStore(join(root, 'proposal.json'), decodeDoomProposal), capture: () => session.checkpoint(),
    failureReceipt: (error: unknown) => error instanceof SupervisorFailure ? error.receipt : undefined };
  await write('manifest.json', { builds, provider: provider.version, limits, requestedKind: kind,
    limitations: ['Local Doom WASM, not VM snapshot performance.', 'Two decisions are a small observed trace, not proof of a repeatable failure.', 'No private acceptance cases, independent evaluation, executable invocation or activation.', 'The existing live session is only read to obtain its user guide.'] });
  console.log(JSON.stringify({ root, phase: 'generating', training: { ticks: training.used('simulation'), modelCalls: training.used('modelCalls') } }));
  const result = await generateDoomProposal(options, control.signal); await ledger.join();
  await write('result.json', { status: result.status, error: result.error, costMicros: ledger.used('costMicros'), activeEpoch: supervisor.snapshot().journal.active.epoch });
  assert.equal(result.status, 'submitted', result.error);
  assert.equal(supervisor.snapshot().journal.active.epoch, 0);
  assert.equal(supervisor.snapshot().journal.proposals[0]!.status, 'proposed');
  assert.deepEqual((await generateDoomProposal(options, control.signal)).candidate, result.candidate);
  assert.equal(ledger.used('supervisorCalls'), 1);
  console.log(JSON.stringify({ root, phase: 'passed', kind: (result.output as { kind: string }).kind, costMicros: ledger.used('costMicros'),
    servingModels: result.receipt?.servingModels, reason: result.reason }));
} finally {
  await session.pause(); await supervisor?.close(); await session.close(); await training.join(); await store.flush();
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
