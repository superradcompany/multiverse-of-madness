import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trainingMenu, type EvaluationContract, type LearningRevision, type TrainingCatalog, type TrainingSelection } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { ChessWorld } from './runtime.ts';
import { ChessAdapter } from './adapter.ts';
import { defaultChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { freezeChessReview, decodeFrozenChessReview } from './review-input.ts';
import { chessTrainingContract } from './curriculum.ts';
import { openChessStrategyLearning } from './strategy-learning.ts';
import { chessTrainingFeedback, type ChessTrainingReport } from './training-feedback.ts';
import type { ChessDecisionModel } from './revisions.ts';
import { ChessComparisonViewer, type ChessComparisonView } from './comparison-view.ts';

test('practice catalog freezes observed histories, excludes acceptance boards, and rejects altered review data', async () => {
  const world = new ChessWorld('observed'), incident = await world.state();
  const mark: ChessAutomaticMark = { origin: { activation: { revision: { id: 'source', version: '1' }, epoch: 0 }, context: { id: 'goal', version: '1' } },
    evidence: { incident, observations: [], reason: 'Observed a repetition', mark: { key: 'test', objective: 'win by checkmate', revision: { id: 'source', version: '1' }, issue: 'repetition', attemptedPlies: 4, selectedPlies: 4, observedAt: 0 } } };
  try {
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) { const before = await world.state(), after = await world.step({ san }); mark.evidence.observations.push({ before, selected: san, after }); }
    const review = freezeChessReview('review', mark, []), catalog = review.training!;
    assert.equal(catalog.scenarios.length, 4); assert.equal(catalog.maximumSelection, 2);
    assert.deepEqual(catalog.scenarios[0]!.input.saved.moves, ['e4', 'e5', 'Nf3', 'Nc6']);
    for (const scenario of catalog.scenarios) for (const acceptance of review.contract.scenarios) assert.notDeepEqual(scenario.input.saved, acceptance.input.saved);
    assert.equal(JSON.stringify(trainingMenu(catalog)).includes('initialFen'), false);
    assert.equal(JSON.stringify(trainingMenu(catalog)).includes('seed'), false);
    const practice = chessTrainingContract(catalog, { catalog: catalog.revision, scenarioIds: [catalog.scenarios[1]!.id], reason: 'Test the earlier decision' }, defaultChessPolicy);
    assert.deepEqual(practice.scenarios[0]!.input, catalog.scenarios[1]!.input);
    assert.notEqual(practice.id, review.contract.id);
    assert.equal(decodeFrozenChessReview(review, 'review').format, 5);
    const altered = structuredClone(review); altered.training!.scenarios[0]!.input.objective = 'different goal';
    assert.throws(() => decodeFrozenChessReview(altered, 'review'), /altered/);
    assert.throws(() => chessTrainingContract(altered.training!, { catalog: catalog.revision, scenarioIds: [catalog.scenarios[0]!.id], reason: 'Altered' }, defaultChessPolicy), /Altered/);
    const repeated = new ChessWorld('repeated'), repetition = structuredClone(mark); repetition.evidence.observations = [];
    try {
      for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) { const before = await repeated.state(), after = await repeated.step({ san }); repetition.evidence.observations.push({ before, selected: san, after }); }
      const repeatedCatalog = freezeChessReview('repeated', repetition, []).training!;
      assert.equal(repeatedCatalog.scenarios.length, 3);
      assert.ok(repeatedCatalog.scenarios.every(scenario => scenario.input.saved.moves.length > 0 && scenario.input.saved.moves.length < 4)); // Same acceptance board with different move counters is still excluded.
    } finally { await repeated.destroy(); }
    mark.evidence.observations[0]!.before.moves.push('a3');
    assert.deepEqual(decodeFrozenChessReview(review, 'review'), review);
  } finally { await world.destroy(); }
});

// Real engine/evaluation/controller plumbing with controlled decisions; no model call or VM execution.
test('winning selected practice cannot qualify a candidate that fails independent acceptance; cancellation never reaches acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-curriculum-'));
  try {
    const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter();
    const artifact = async (name: string): Promise<LearningRevision<ChessPolicy>> => {
      const executor = (await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `export default () => ${JSON.stringify(name)};` } })).revision;
      const fields = { executor, adapter: adapter.version, model: { id: 'controlled-curriculum', version: '1' }, policy: { ...defaultChessPolicy, threshold: 0 }, prompts: {}, skills: [] };
      return { ...fields, revision: contentRevision('chess-learning-system', fields) };
    };
    const baseline = await artifact('baseline'), candidate = await artifact('candidate');
    const start = new ChessWorld('start'), opening = await start.state(); await start.destroy();
    const acceptance: EvaluationContract<ChessStrategyScenario> = { id: 'private-host-contract', evaluator: { id: 'fixture-evaluation', version: '1' },
      scenarios: [{ id: 'private-position', seed: 'private-seed', input: { saved: { initialFen: opening.initialFen, moves: [] }, objective: 'win by checkmate', player: 'w', plies: 1 } }],
      budget: { simulationUnit: 'chess-plies', limits: { simulation: 1, modelCalls: 1 } }, maxRunMs: 1000,
      acceptance: { metric: 'wins', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
    const fields = { format: 1 as const, maximumSelection: 1, scenarios: [{ id: 'observed-practice', label: 'Observed mate opportunity', description: 'Previously observed position', seed: 'practice-seed',
      input: { saved: { initialFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', moves: [] }, objective: 'win by checkmate', player: 'w' as const, plies: 4 } }] };
    const catalog: TrainingCatalog<ChessStrategyScenario> = { ...fields, revision: contentRevision('chess-training-catalog', fields) };
    const selection: TrainingSelection = { catalog: catalog.revision, scenarioIds: ['observed-practice'], reason: 'Test the observed mate opportunity' };
    let preview: ChessComparisonView | undefined;
    const previewStore = { load: async () => structuredClone(preview), save: async (value: ChessComparisonView) => { preview = structuredClone(value); }, flush: async () => {} };
    const viewer = await ChessComparisonViewer.open(previewStore);
    const paths: string[] = []; let interrupt: AbortController | undefined, changeContext = false, contextVersion = '1';
    const model = (improved: boolean): ChessDecisionModel => ({ version: baseline.model, async decide(request) {
      interrupt?.abort(new Error('Cancel the practice fixture'));
      if (changeContext) contextVersion = '2';
      const selected = (improved ? request.candidates.find(plan => plan.id.endsWith('#') || plan.id === 'e4') : request.candidates.find(plan => plan.id === 'Kf5' || plan.id === 'a3')) ?? request.candidates[0]!;
      return { selected: selected.id, confidence: 1, preferences: request.candidates.map(plan => ({ id: plan.id, probability: Number(plan.id === selected.id) })), usage: { calls: 0 } };
    } });
    const options: Parameters<typeof openChessStrategyLearning>[0] = { directory, baseline, contract: acceptance, store,
      context: () => ({ id: 'context', version: contextVersion }), objective: () => 'win by checkmate', boundary: work => work(),
      training: async () => ({ catalog, selection }), trainingObserver: id => viewer.observer(id, 'training'), liveModel: () => model(false),
      evaluationModel: async (artifact, _ledger, run) => { paths.push(run); return model(artifact.executor.version === candidate.executor.version); },
    };
    let learning = await openChessStrategyLearning(options);
    await learning.controller.submit({ id: 'practice-success', candidate, reason: 'Select useful practice', expiresAt: Date.now() + 60000 });
    const result = await learning.controller.evaluate('practice-success');
    assert.equal(result.status, 'rejected'); assert.equal(learning.controller.active.epoch, 0);
    const readPractice = async (id: string) => JSON.parse(await readFile(join(directory, 'evaluations', id, 'training/report.json'), 'utf8')) as ChessTrainingReport;
    const practice = await readPractice('practice-success');
    assert.equal(practice.comparison.accepted, true); assert.ok(practice.comparison.meanGain! > 0);
    assert.equal(viewer.snapshot()!.kind, 'training'); assert.match(viewer.snapshot()!.reason!, /Separate host tests/);
    assert.equal((await ChessComparisonViewer.open(previewStore)).snapshot()!.kind, 'training');
    const report = JSON.parse(await readFile(join(directory, 'evaluations/practice-success/comparison.json'), 'utf8'));
    assert.equal(report.accepted, false); assert.deepEqual(report.contract, acceptance);
    assert.deepEqual(report.runs.map((run: { scenarioId: string }) => run.scenarioId), ['private-position', 'private-position']);
    assert.ok(paths.some(path => path.includes('/training/'))); assert.ok(paths.some(path => path.includes('/private-position/')));
    learning = await openChessStrategyLearning(options);
    const feedback = await chessTrainingFeedback(learning.controller.snapshot(), readPractice);
    assert.equal(feedback[0]!.purpose, 'practice'); assert.equal(feedback[0]!.results[0]!.complete, true);
    assert.equal(JSON.stringify(feedback).includes('private-position'), false);
    assert.equal(JSON.stringify(feedback).includes('accepted'), false);
    await assert.rejects(chessTrainingFeedback(learning.controller.snapshot(), async id => { const receipt = await readPractice(id); receipt.comparison.meanGain = 999999; return receipt; }), /differs/);
    paths.length = 0; interrupt = new AbortController();
    await learning.controller.submit({ id: 'cancelled-practice', candidate, reason: 'Cancel during owned practice', expiresAt: Date.now() + 60000 });
    const cancelled = await learning.controller.evaluate('cancelled-practice', interrupt.signal);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(learning.controller.active.epoch, 0);
    assert.ok(paths.length > 0); assert.ok(paths.every(path => path.includes('/training/')));
    assert.equal(cancelled.qualification, undefined);
    const previousCalls = paths.length;
    learning = await openChessStrategyLearning(options);
    await assert.rejects(learning.controller.evaluate('cancelled-practice'), /already been evaluated/);
    assert.equal(paths.length, previousCalls);
    paths.length = 0; interrupt = undefined; changeContext = true;
    await learning.controller.submit({ id: 'changed-context', candidate, reason: 'Respect changes during practice', expiresAt: Date.now() + 60000 });
    const stale = await learning.controller.evaluate('changed-context');
    assert.equal(stale.status, 'stale'); assert.equal(stale.qualification, undefined);
    assert.ok(paths.length > 0); assert.ok(paths.every(path => path.includes('/training/')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
