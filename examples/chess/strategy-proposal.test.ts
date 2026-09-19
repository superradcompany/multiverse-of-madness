import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, type ExecutableSource, type SupervisorProvider, type TrainingCatalog } from '@multiverse/gameplay-harness';
import { ExecutableStore, contentRevision } from '@multiverse/gameplay-harness/node';
import { ChessAdapter } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { describeChess } from './description.ts';
import { defaultChessPolicy } from './policy.ts';
import { proposeChessStrategy, type ChessStrategyEvidence } from './strategy-proposal.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';

test('strategy bootstrap uses the mechanics contract and unchanged user goal; publishes only inert source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-strategy-proposal-'));
  try {
    const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter();
    const source: ExecutableSource = { format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'export default input => input;' } };
    const baseline = await store.put(source), fields = { executor: baseline.revision, adapter: adapter.version, model: { id: 'prepared-jev', version: 'test' }, policy: defaultChessPolicy, prompts: {}, skills: [] };
    const current = { ...fields, revision: contentRevision('chess-learning-system', fields) };
    const origin = { activation: { revision: current.revision, epoch: 0 }, context: { id: 'context', version: '1' } };
    const proposed: ExecutableSource = { ...source, files: { 'main.ts': 'throw new Error("not on the host");' } };
    const feedback = { candidate: { id: 'source', version: 'rejected' }, objective: 'Protect the queen', metric: 'value', accepted: false, reason: 'Material loss', pairedGains: [-2], runs: [] };
    let calls = 0, trainingDraft: unknown;
    const trainingFeedback = { purpose: 'practice' as const, candidate: { id: 'candidate', version: 'old' }, objective: 'Protect the queen', reason: 'Test observed weakness', results: [{ scenarioId: 'observed', gain: -2, complete: true }] };
    const provider: SupervisorProvider<ChessPolicy, ChessStrategyEvidence> = {
      version: { id: 'fixture', version: '1' }, async propose(request) {
        calls++;
        assert.equal(request.objective, 'Protect the queen');
        assert.deepEqual(request.evidence.observations, []);
        assert.match(request.task, /Jev, not this code, selects/);
        assert.match(request.task, /Empty observations means bootstrap/);
        assert.equal(request.evidence.game.controls[0]!.legalChoices, '/legalMoves');
        if (calls === 1) assert.deepEqual(Object.keys(request.evidence).sort(), ['currentSource', 'game', 'observations']);
        else if (request.evidence.training) {
          assert.equal(request.evidence.training.maximumSelection, 1);
          assert.deepEqual(request.evidence.training.scenarios, [{ id: 'observed', label: 'Observed position', description: 'A known problem' }]);
          assert.deepEqual(request.evidence.recentTraining, [trainingFeedback]);
          assert.match(request.task, /Practice cannot qualify a revision/);
        } else { assert.deepEqual(request.evidence.recentEvaluations, [feedback]); assert.equal(request.evidence.review?.issue, 'material-loss'); }
        assert.match(request.task, /Prefer a compact change/);
        return { draft: { reason: 'A strategy for testing', source: proposed, ...(trainingDraft ? { training: trainingDraft } : {}) }, receipt: { id: request.id, provider: this.version, startedAt: 0, elapsedMs: 1, inputBytes: 1, outputBytes: 1, status: 'complete', requestedModel: 'fixture', servingModels: ['fixture'], usage: { inputTokens: 30, outputTokens: 20 } } };
      },
    };
    const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: {} });
    const options = { id: 'test-proposal', origin, current, objective: 'Protect the queen', game: describeChess(adapter.version, new ChessRuntimeStore('unused').capabilities),
      contract: { id: 'private-acceptance', version: '1' }, observations: [], provider, store, ledger,
      limits: { timeoutMs: 300000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 2000000 } };
    const result = await proposeChessStrategy(options, new AbortController().signal);
    assert.deepEqual((await store.get(result.artifact.executor)).source, proposed);
    assert.notDeepEqual(result.artifact.revision, current.revision);
    assert.deepEqual(result.origin, origin);
    assert.deepEqual(result.artifact.policy, current.policy);
    assert.deepEqual(result.artifact.model, current.model);
    assert.equal(ledger.snapshot().entries[0]!.usage!.inputTokens, 30);
    assert.equal(ledger.snapshot().entries[0]!.usage!.outputTokens, 20);
    assert.equal(ledger.snapshot().entries[0]!.usage!.costMicros, undefined);
    await proposeChessStrategy({ ...options, id: 'follow-up', recentEvaluations: [feedback], review: { issue: 'material-loss', reason: 'Learn from the measured rejection' } }, new AbortController().signal);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(proposeChessStrategy(options, cancelled.signal));
    await assert.rejects(proposeChessStrategy({ ...options, game: { ...options.game, adapter: { id: 'wrong', version: '1' } } }, new AbortController().signal), /does not match/);
    assert.equal(calls, 2);
    const trainingFields = { format: 1 as const, maximumSelection: 1, scenarios: [{ id: 'observed', label: 'Observed position', description: 'A known problem', seed: 'host-fixed',
      input: { saved: { initialFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', moves: [] }, objective: 'Protect the queen', player: 'w' as const, plies: 4 } }] };
    const training: TrainingCatalog<ChessStrategyScenario> = { ...trainingFields, revision: contentRevision('chess-training-catalog', trainingFields) };
    const selected = { catalog: training.revision, scenarioIds: ['observed'], reason: 'Investigate the observed loss' };
    trainingDraft = selected;
    const withPractice = await proposeChessStrategy({ ...options, id: 'with-practice', training, recentTraining: [trainingFeedback] }, new AbortController().signal);
    assert.deepEqual(withPractice.training, selected);
    assert.deepEqual(withPractice.artifact, result.artifact); // Practice scheduling cannot mutate gameplay or acceptance artifacts.
    trainingDraft = { ...selected, scenarioIds: ['private-acceptance'] };
    await assert.rejects(proposeChessStrategy({ ...options, id: 'invented-case', training, recentTraining: [trainingFeedback] }, new AbortController().signal), /training selection/);
    trainingDraft = { ...selected, catalog: { ...training.revision, version: 'stale' } };
    await assert.rejects(proposeChessStrategy({ ...options, id: 'stale-practice', training, recentTraining: [trainingFeedback] }, new AbortController().signal), /training selection/);
    assert.equal(calls, 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
