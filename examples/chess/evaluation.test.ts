import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { ChessAdapter } from './adapter.ts';
import { ChessWorld } from './runtime.ts';
import { defaultChessPolicy } from './policy.ts';
import { freezeChessReview, decodeFrozenChessReview } from './review-input.ts';
import { chessIncidentContractVersion } from './incident-contract.ts';
import { openChessStrategyLearning } from './strategy-learning.ts';
import { compareChessEvaluation } from './evaluation.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessHarnessEvidence } from './harness-evaluation.ts';
import type { EvaluationComparison } from '@multiverse/gameplay-harness';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { ChessComparisonViewer, type ChessComparisonView } from './comparison-view.ts';

// Controlled model decisions exercise the real revision/evaluation/session route, not model strength or VM isolation.
test('new frozen reviews qualify through full sessions, persist attempted work and restore without redispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-review-routing-'));
  try {
    const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter(), modelVersion = { id: 'fixture', version: '1' };
    const make = async (name: string) => {
      const source = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `throw new Error('${name}');` } });
      const data = { executor: source.revision, adapter: adapter.version, model: modelVersion, policy: defaultChessPolicy, prompts: {}, skills: [] };
      return { ...data, revision: contentRevision('chess-strategy', data) };
    };
    const baseline = await make('baseline'), candidate = await make('candidate');
    const world = new ChessWorld('incident'); await world.step({ san: 'e4' });
    const incident = await world.state(); await world.destroy();
    const context = { id: 'goal', version: '1' }, objective = 'win by checkmate';
    const mark: ChessAutomaticMark = { origin: { activation: { epoch: 0, revision: baseline.revision }, context },
      evidence: { incident, observations: [], reason: 'Test the observed incident', mark: { key: 'observed', objective, revision: baseline.revision, issue: 'repetition', observedAt: 0, attemptedPlies: 8, selectedPlies: 1 } } };
    const review = freezeChessReview('proposal', mark, [], baseline.policy);
    const previews: ChessComparisonView[] = [];
    const viewer = await ChessComparisonViewer.open({ flush: async () => {}, load: async () => undefined, save: async value => { previews.push(structuredClone(value)); } });
    let prepared = 0;
    const model: Parameters<typeof openChessStrategyLearning>[0]['evaluationModel'] = async (artifact, budget, run) => ({
      version: artifact.model,
      prepare: (request, signal) => budget.run({ owner: run, operation: 'controlled-preparation', reserve: { executorCalls: 1 } }, async () => {
        prepared++; return { value: request, usage: { executorCalls: 1 } };
      }, signal),
      decide: async request => ({ selected: request.candidates[0]!.id, confidence: .2,
        preferences: request.candidates.map((plan, i) => ({ id: plan.id, probability: i < 2 ? .5 : 0 })), usage: { calls: 0 } }),
    });
    const open = () => openChessStrategyLearning({ directory: join(directory, 'learning'), baseline, store,
      contract: { version: chessIncidentContractVersion, resolve: async id => decodeFrozenChessReview(review, id).contract },
      context: () => context, objective: () => objective, boundary: work => work(), evaluationModel: model,
      evaluationObserver: id => viewer.observer(id, 'proposal'),
      liveModel: () => { throw new Error('Qualification must not open a live model'); },
    });
    const owner = await open();
    await owner.controller.submit({ id: 'proposal', candidate, reason: 'Controlled source comparison', expiresAt: Date.now() + 60000 });
    const result = await owner.controller.evaluate('proposal');
    assert.equal(result.status, 'rejected'); assert.equal(owner.controller.active.epoch, 0);
    const report = JSON.parse(await readFile(join(directory, 'learning/evaluations/proposal/comparison.json'), 'utf8')) as EvaluationComparison<ChessStrategyScenario, ChessHarnessEvidence>;
    assert.equal(report.runs.length, 12);
    assert.ok(report.runs.every(run => run.status === 'complete'), JSON.stringify(report.runs.map(run => run.error)));
    assert.ok(report.runs.every(run => run.evidence!.harness.attempts.plies > run.evidence!.harness.selectedPlies));
    assert.ok(report.runs.some(run => run.evidence!.harness.committed.ply > run.evidence!.after.ply));
    assert.equal(report.contract.evaluator.id, 'chess-full-harness-incident-evaluation');
    assert.ok(previews.some(view => view.runs.some(run => run.status === 'running' && run.trials.length > 0)));
    assert.equal(viewer.snapshot()!.status, 'finished');
    assert.equal(viewer.summary()!.completed, 12);
    for (const run of report.runs) {
      const recorded = viewer.snapshot()!.runs.find(item => item.scenarioId === run.scenarioId && item.role === run.role)!;
      assert.deepEqual(recorded.frames.at(-1), run.evidence!.after);
      assert.equal(recorded.frames.length, run.evidence!.moves.length + 1);
      assert.equal(recorded.attemptedPlies, run.evidence!.harness.attempts.plies);
    }
    const calls = prepared, reopened = await open();
    assert.deepEqual(reopened.controller.snapshot(), owner.controller.snapshot()); assert.equal(prepared, calls);
    const invalid = structuredClone(review.contract); invalid.evaluator.version = 'unknown';
    await assert.rejects(async () => compareChessEvaluation({ directory: join(directory, 'invalid'), contract: invalid, baseline, candidate, model }, new AbortController().signal), /Unsupported/);
    assert.equal(prepared, calls);
    // Preview delivery is optional; authoritative qualification still completes if the viewer is unavailable.
    const broken = viewer.observer('offline', 'proposal');
    for (const key of ['start', 'progress', 'run', 'finish', 'failed'] as const) broken[key] = async () => { throw new Error('Preview unavailable'); };
    const replayed = await compareChessEvaluation({ directory: join(directory, 'offline-preview'), contract: review.contract, baseline, candidate, model, observer: broken }, new AbortController().signal);
    assert.equal(replayed.accepted, report.accepted); assert.ok(replayed.runs.every(run => run.status === 'complete'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
