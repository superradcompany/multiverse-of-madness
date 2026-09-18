import test from 'node:test';
import assert from 'node:assert/strict';
import { RevisionController, type CheckpointStore, type EvaluationComparison, type LearningRevision } from '@multiverse/gameplay-harness';
import { ChessRegressionAudits, auditRegression, type ChessRegressionJournal } from './regression-audits.ts';
import { observeChessLearning } from './learning-observation.ts';
import { ChessWorld } from './runtime.ts';
import { ChessAdapter } from './adapter.ts';
import { defaultChessPolicy } from './policy.ts';
import { chessAuditFeedback } from './evaluation-feedback.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import { chessIncidentContract } from './incident-contract.ts';

type Report = EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
function store<T>(): CheckpointStore<T> { let value: T | undefined; return { load: async () => structuredClone(value), save: async next => { value = structuredClone(next); }, flush: async () => {} }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const before: LearningRevision<ChessPolicy> = { revision: { id: 'strategy', version: '0' }, policy: defaultChessPolicy, prompts: {}, skills: [], executor: { id: 'source', version: '0' }, adapter: new ChessAdapter().version, model: { id: 'fixture', version: '1' } };
  const after = { ...before, revision: { id: 'strategy', version: '1' }, executor: { id: 'source', version: '1' } };
  let context = { id: 'goal', version: '1' }, ready = true, calls = 0, cleanups = 0;
  const controller = await RevisionController.create(before, { contract: { id: 'host', version: '1' }, capabilities: ['executor'], maxLifetimeMs: 60000 }, {
    context: () => context, boundary: work => work(), persist: async () => {}, verify: async () => {}, compatible: async () => {},
    qualify: async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision, contract: request.contract, context: request.context, accepted: true, reason: 'Fixture promotion', evidence: {} }),
  });
  await controller.submit({ id: 'promotion', candidate: after, reason: 'Fixture', expiresAt: Date.now() + 60000 }); await controller.evaluate('promotion'); await controller.activate('promotion');
  const world = new ChessWorld('observed'); for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) await world.step({ san });
  const snapshot = { mainId: 'observed', worlds: [{ meta: { id: 'observed' }, state: await world.state() }], objective: 'win', attempts: { plies: 4 }, pendingInputs: {}, provenance: { model: after.model } } as ChessSessionCheckpoint;
  const mark: ChessAutomaticMark = { evidence: observeChessLearning(snapshot, undefined, { bootstrap: true, revision: after.revision })!, origin: { activation: controller.active, context } };
  await world.destroy();
  const storage = store<ChessRegressionJournal>(), reports = new Map<string, Report>();
  const options = { binding: { id: 'journal', version: '1' }, controller, store: storage, context: () => context, ready: () => ready,
    read: async (id: string) => structuredClone(reports.get(id)), write: async (id: string, report: Report) => { reports.set(id, structuredClone(report)); },
    recover: async () => { cleanups++; },
    evaluate: async (audit: { review: { contract: Report['contract'] } }, _before: unknown, _after: unknown, signal: AbortSignal): Promise<Report> => {
      calls++; signal.throwIfAborted();
      const contract = audit.review.contract;
      return { contract, baseline: before.revision, candidate: after.revision, accepted: false, reason: 'Regressed', gains: [], runs: contract.scenarios.flatMap(scenario => (['baseline', 'candidate'] as const).map(role => ({
        id: `${scenario.id}/${role}`, role, revision: role === 'baseline' ? before.revision : after.revision, scenarioId: scenario.id, seed: scenario.seed, status: 'complete' as const,
        metrics: { value: role === 'baseline' ? 0 : -3 }, budget: { version: 1 as const, spec: contract.budget, entries: [] },
      }))) };
    },
  };
  return { options, controller, mark, storage, reports, get calls() { return calls; }, get cleanups() { return cleanups; }, guide() { context = { id: 'goal', version: '2' }; }, ready(value: boolean) { ready = value; } };
}

test('regression audit is background, joins cleanup, waits for a boundary and rolls back once with compact feedback', async () => {
  const f = await fixture(), release = deferred(), evaluate = f.options.evaluate;
  f.options.evaluate = async (...args) => { await release.promise; return evaluate(...args); };
  const owner = await ChessRegressionAudits.open(f.options);
  assert.equal(await owner.tick(f.mark), true); assert.equal(owner.busy, true); assert.equal(f.controller.active.epoch, 1);
  await owner.tick(f.mark); release.resolve(); await owner.join(); f.ready(false);
  await owner.tick(); assert.equal(f.controller.active.epoch, 1);
  f.ready(true); await owner.tick(); assert.equal(f.controller.active.epoch, 2); assert.equal(f.controller.current.revision.version, '0');
  assert.equal(owner.snapshot().audits[0]!.status, 'rolled-back'); assert.equal(f.controller.snapshot().proposals[0]!.status, 'activated');
  const feedback = await chessAuditFeedback(owner.snapshot(), f.options.read);
  assert.equal(feedback.length, 1); assert.equal(feedback[0]!.accepted, false);
  assert.doesNotMatch(JSON.stringify(feedback), /initialFen|secret|scenarios|ordinary-opening/);
  await owner.close(); const reopened = await ChessRegressionAudits.open(f.options); await reopened.tick(f.mark);
  assert.equal(f.calls, 1); assert.equal(f.controller.active.epoch, 2); assert.ok(f.cleanups >= 3); await reopened.close();
});

test('a goal change invalidates a completed audit without rollback', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  await owner.tick(f.mark); await owner.join(); f.guide(); await owner.tick();
  assert.equal(owner.snapshot().audits[0]!.status, 'stale'); assert.equal(f.controller.active.epoch, 1); await owner.close();
});

test('an old evaluator permits exactly one new check in the same activation, preserving historical audit evidence', async () => {
  const f = await fixture(), evaluate = f.options.evaluate;
  f.options.evaluate = async (...args) => {
    const report = await evaluate(...args);
    for (const run of report.runs) run.metrics!.value = 0;
    return report;
  };
  const legacy: ChessRegressionJournal = { version: 1, binding: f.options.binding, audits: [{
    id: 'old-rules', review: { format: 3, id: 'old-rules', mark: f.mark, contract: chessIncidentContract(f.mark, 3) },
    baseline: { id: 'strategy', version: '0' }, status: 'retained', createdAt: 1, reason: 'Kept under old rules',
  }] };
  await f.storage.save(legacy);
  const owner = await ChessRegressionAudits.open(f.options);
  assert.equal(owner.snapshot().version, 2); assert.deepEqual(owner.snapshot().audits, legacy.audits);
  assert.equal(owner.hasCurrentCheck(), false);
  await owner.tick(f.mark); await owner.join(); await owner.tick();
  assert.equal(owner.hasCurrentCheck(), true); assert.equal(f.calls, 1); assert.equal(f.controller.active.epoch, 1);
  assert.equal(owner.snapshot().audits.length, 2); assert.deepEqual(owner.snapshot().audits[0], legacy.audits[0]);
  for (let attempt = 0; attempt < 5; attempt++) await owner.tick(f.mark);
  assert.equal(f.calls, 1); await owner.close();
  const reopened = await ChessRegressionAudits.open(f.options); await reopened.tick(f.mark);
  assert.equal(f.calls, 1); assert.equal(reopened.snapshot().audits.length, 2); await reopened.close();
  const duplicate = (await f.storage.load())!;
  const copy = structuredClone(duplicate.audits[1]!); copy.id = 'duplicate'; copy.review.id = 'duplicate'; duplicate.audits.push(copy);
  await f.storage.save(duplicate); await assert.rejects(ChessRegressionAudits.open(f.options), /Invalid chess regression audit/);
  const invalidLegacy = structuredClone(legacy); invalidLegacy.audits.push({ ...structuredClone(copy), review: { ...copy.review, id: copy.id } });
  await f.storage.save(invalidLegacy); await assert.rejects(ChessRegressionAudits.open(f.options), /Invalid chess regression audit/);
});

test('partial or cancelled comparisons and insufficient improvement never prove regression', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  await owner.tick(f.mark); await owner.join(); const report = [...f.reports.values()][0]!;
  assert.equal(auditRegression(report).regressed, true);
  const partial = structuredClone(report); partial.runs.pop(); assert.equal(auditRegression(partial).regressed, false);
  const cancelled = structuredClone(report); cancelled.runs[0]!.status = 'cancelled'; assert.equal(auditRegression(cancelled).regressed, false);
  const short = structuredClone(report);
  short.runs[0]!.evidence = { player: 'w', before: f.mark.evidence.incident, after: f.mark.evidence.incident, moves: [] };
  assert.equal(auditRegression(short).regressed, false);
  assert.match(auditRegression(short).reason, /scoring horizon/);
  const equal = structuredClone(report); for (const run of equal.runs) run.metrics!.value = 0; assert.equal(auditRegression(equal).regressed, false);
  const corrupt = structuredClone(report); corrupt.runs[0]!.role = 'candidate'; assert.throws(() => auditRegression(corrupt), /pair|samples/);
  await owner.close();
});

test('restart after lost report acknowledgment recovers the result without paid redispatch', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  await owner.tick(f.mark); await owner.join(); await owner.close();
  const durable = (await f.storage.load())!; durable.audits[0]!.status = 'evaluating'; delete durable.audits[0]!.comparison; await f.storage.save(durable);
  const reopened = await ChessRegressionAudits.open(f.options); await reopened.tick();
  assert.equal(f.calls, 1); assert.equal(f.controller.active.epoch, 2); await reopened.close();
});

test('restart after durable rollback preserves the new epoch even if audit acknowledgment was lost', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  await owner.tick(f.mark); await owner.join(); const pending = owner.snapshot(); await owner.tick(); await owner.close();
  await f.storage.save(pending); const reopened = await ChessRegressionAudits.open(f.options); await reopened.tick();
  assert.equal(reopened.snapshot().audits[0]!.status, 'rolled-back'); assert.equal(f.controller.active.epoch, 2); assert.equal(f.calls, 1); await reopened.close();
});

test('interrupted audit never repeats a paid request, and tampered durable reports cannot roll back', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  await owner.tick(f.mark); await owner.join(); await owner.close();
  const durable = (await f.storage.load())!, id = durable.audits[0]!.id;
  const report = f.reports.get(id)!; report.candidate.version = 'forged';
  const reopened = await ChessRegressionAudits.open(f.options); await assert.rejects(reopened.tick(), /receipt changed/); await reopened.close();
  durable.audits[0]!.status = 'evaluating'; delete durable.audits[0]!.comparison; await f.storage.save(durable); f.reports.clear();
  const interrupted = await ChessRegressionAudits.open(f.options); await interrupted.tick(f.mark);
  assert.equal(interrupted.snapshot().audits[0]!.status, 'interrupted'); assert.equal(f.calls, 1); assert.equal(f.controller.active.epoch, 1); await interrupted.close();
});

test('cancellation joins the dispatched comparison and cleanup, without scheduling another audit', async () => {
  const f = await fixture(), entered = deferred(), cleaned = deferred();
  let dispatched = 0;
  f.options.evaluate = async (_audit, _before, _after, signal) => {
    dispatched++; entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await cleaned.promise; signal.throwIfAborted(); throw new Error('unreachable');
  };
  const owner = await ChessRegressionAudits.open(f.options); await owner.tick(f.mark); await entered.promise;
  let joined = false; const cancelling = owner.cancel().then(() => { joined = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(joined, false); assert.equal(owner.busy, true);
  cleaned.resolve(); await cancelling; assert.equal(owner.busy, false); await owner.tick(f.mark);
  assert.equal(dispatched, 1); assert.equal(owner.snapshot().audits[0]!.status, 'failed'); assert.equal(f.controller.active.epoch, 1); await owner.close();
});

test('a durable admission failure cannot dispatch evaluation', async () => {
  const f = await fixture(), owner = await ChessRegressionAudits.open(f.options);
  f.storage.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(owner.tick(f.mark), /disk unavailable/); await assert.rejects(owner.tick(f.mark), /disk unavailable/);
  assert.equal(f.calls, 0); assert.equal(f.controller.active.epoch, 1); await owner.close();
});
