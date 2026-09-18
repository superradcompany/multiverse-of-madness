import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EvaluationContract } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { defaultChessPolicy } from './policy.ts';
import { openChessStrategyLearning } from './strategy-learning.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

// Controlled decisions exercise real evaluation/revision/session plumbing, not a chess-strength or VM claim.
test('measured chess qualifications activate at session boundaries, survive reconnect, and retain replay provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-learning-'));
  let session: ChessSession | undefined;
  try {
    const store = new ExecutableStore(join(root, 'sources')), adapter = new ChessAdapter();
    const make = async (name: string) => {
      const executable = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `throw new Error(${JSON.stringify(name)});` } });
      const data = { executor: executable.revision, adapter: adapter.version, model: { id: 'recording-strategy', version: '1' }, policy: { ...defaultChessPolicy, threshold: 0 }, prompts: {}, skills: [] };
      return { ...data, revision: contentRevision('chess-strategy', data) };
    };
    const baseline = await make('baseline'), candidate = await make('candidate');
    const contract: EvaluationContract<ChessStrategyScenario> = { id: 'controlled-mate', evaluator: { id: 'fixture-host-metrics', version: '1' },
      scenarios: [{ id: 'held-out', seed: 'fixed', input: { saved: { initialFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', moves: [] }, objective: 'win by checkmate', player: 'w', plies: 1 } }],
      budget: { simulationUnit: 'chess-plies', limits: { simulation: 1, modelCalls: 1 } }, maxRunMs: 1000,
      acceptance: { metric: 'wins', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
    const model = (improved: boolean): ChessDecisionModel => ({ version: baseline.model, async decide(request) {
      const selected = (improved ? request.candidates.find(p => p.id.endsWith('#') || p.id === 'e4') : request.candidates.find(p => p.id === 'Kf5' || p.id === 'a3')) ?? request.candidates[0]!;
      return { selected: selected.id, confidence: 1, preferences: request.candidates.map(p => ({ id: p.id, probability: Number(p.id === selected.id) })), usage: { calls: 0 } };
    } });
    const open = (overrides: Partial<Parameters<typeof openChessStrategyLearning>[0]> = {}) => openChessStrategyLearning({ directory: join(root, 'learning'), baseline, contract, store,
      context: () => session?.supervisorContext() ?? { id: 'bootstrap-context', version: '1' }, objective: () => session?.snapshot().objective ?? 'win by checkmate',
      boundary: work => session!.revisionBoundary(work), evaluationModel: async artifact => model(artifact.executor.version === candidate.executor.version),
      liveModel: artifact => model(artifact.executor.version === candidate.executor.version),
      ...overrides,
    });
    let learning = await open(); const runtime = new ChessRuntimeStore(join(root, 'runtime'));
    session = await ChessSession.create(join(root, 'session'), runtime, adapter, new ChessFixtureModel(), baseline.policy, learning.binding);
    await session.step(); assert.equal(session.snapshot().attempts.plies, 1);
    await learning.controller.submit({ id: 'better', candidate, reason: 'Test measured candidate', expiresAt: Date.now() + 60000 });
    assert.equal((await learning.controller.evaluate('better')).status, 'qualified');
    const report = JSON.parse(await readFile(join(root, 'learning/evaluations/better/comparison.json'), 'utf8'));
    assert.equal(report.accepted, true); assert.equal(report.runs.length, 2);
    await learning.controller.activate('better'); await session.detach(); session = undefined;
    learning = await open();
    session = await ChessSession.restore(join(root, 'session'), runtime, adapter, new ChessFixtureModel(), learning.binding);
    assert.equal(learning.controller.active.epoch, 1); await session.step();
    assert.equal((await session.replayFrame(1)).world.provenance.learning?.epoch, 0);
    assert.equal((await session.replayFrame(2)).world.provenance.learning?.epoch, 1);
    const beforeRollback = session.snapshot(), replayBeforeRollback = await session.replay();
    await learning.controller.rollback(baseline.revision, 'Return to previous source', { activation: learning.controller.active, context: session.supervisorContext() });
    assert.equal(learning.controller.active.epoch, 2);
    assert.deepEqual(session.snapshot(), beforeRollback); assert.deepEqual(await session.replay(), replayBeforeRollback);
    await session.step(); assert.equal((await session.replayFrame(3)).world.provenance.learning?.epoch, 2);
    await learning.controller.submit({ id: 'stale', candidate, reason: 'Old objective evidence', expiresAt: Date.now() + 60000 });
    await learning.controller.evaluate('stale'); await session.guide('avoid draws');
    assert.equal((await learning.controller.activate('stale')).status, 'stale');
    assert.equal(learning.controller.active.epoch, 2);
    await learning.controller.submit({ id: 'new-goal', candidate, reason: 'Needs a matching evaluation goal', expiresAt: Date.now() + 60000 });
    const failed = await learning.controller.evaluate('new-goal');
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /current user objective/);
    let resolved = '';
    const dynamic = await open({ directory: join(root, 'dynamic'), contract: { version: { id: 'incident-policy', version: '1' }, resolve: async id => {
      resolved = id; const frozen = structuredClone(contract); frozen.scenarios[0]!.input.objective = session!.snapshot().objective; return frozen;
    } } });
    await dynamic.controller.submit({ id: 'new-context', candidate, reason: 'Evaluate the current frozen goal', expiresAt: Date.now() + 60000 });
    const evaluated = await dynamic.controller.evaluate('new-context');
    assert.equal(resolved, 'new-context'); assert.equal(evaluated.status, 'qualified');
    const dynamicReport = JSON.parse(await readFile(join(root, 'dynamic/evaluations/new-context/comparison.json'), 'utf8'));
    assert.equal(dynamicReport.contract.scenarios[0].input.objective, 'avoid draws');
    assert.ok((evaluated.qualification!.evidence as { evaluatedContract: unknown }).evaluatedContract);
  } finally { await session?.detach(); await rm(root, { recursive: true, force: true }); }
});
