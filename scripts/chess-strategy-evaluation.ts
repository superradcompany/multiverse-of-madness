import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_POSITION } from 'chess.js';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { type EvaluationContract, type LearningRevision, type RevisionJournal } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../packages/executor-microsandbox/src/executor.ts';
import { ChessJevModel } from '../examples/chess/jev.ts';
import { ChessPreparedModel } from '../examples/chess/prepared-model.ts';
import { type ChessStrategyScenario } from '../examples/chess/strategy-evaluation.ts';
import { compareChessEvaluation } from '../examples/chess/evaluation.ts';
import { chessHarnessContract } from '../examples/chess/evaluation-contract.ts';
import { openChessStrategyLearning } from '../examples/chess/strategy-learning.ts';
import { chessIncidentContract } from '../examples/chess/incident-contract.ts';
import { summarizeChessComparison } from '../examples/chess/comparison-summary.ts';
import { observeChessLearning } from '../examples/chess/learning-observation.ts';
import type { ChessAutomaticMark } from '../examples/chess/automatic-learning.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from '../examples/chess/session-types.ts';
import type { ChessState } from '../examples/chess/runtime.ts';

const args = process.argv.slice(2), qualify = args.at(-1) === '--qualify', fullHarness = qualify || args.at(-1) === '--harness';
if (fullHarness) args.pop();
if (args.length !== 2) throw new Error('Usage: chess-strategy-evaluation.ts BOOTSTRAP_DIRECTORY SAVED_WEB_VIEW_JSON | --learning-session SESSION_DIRECTORY [--harness|--qualify] | --comparison COMPARISON_DIRECTORY --harness|--qualify');
const fromSession = args[0] === '--learning-session', fromComparison = args[0] === '--comparison';
if (fromComparison && !fullHarness) throw new Error('Reusing a frozen comparison currently requires --harness');
const bootstrap = resolve(fromSession || fromComparison ? args[1]! : args[0]!);
let frozenView: { mainId: string; objective: string; worlds: Array<{ id: string; state: ChessState }> };
let candidate: LearningRevision<ChessPolicy>, originalBaseline: LearningRevision<ChessPolicy> | undefined, incidentMark: ChessAutomaticMark | undefined;
let frozenContract: EvaluationContract<ChessStrategyScenario> | undefined;
const originalStore = new ExecutableStore(join(bootstrap, fromSession ? 'learning/sources' : 'sources'));
if (fromComparison) {
  const manifest = JSON.parse(await readFile(join(bootstrap, 'manifest.json'), 'utf8')) as {
    frozenView: typeof frozenView; baseline: LearningRevision<ChessPolicy>; candidate: LearningRevision<ChessPolicy>; contract: EvaluationContract<ChessStrategyScenario>;
  };
  ({ frozenView, baseline: originalBaseline, candidate, contract: frozenContract } = manifest);
} else if (fromSession) {
  const saved = JSON.parse(await readFile(join(bootstrap, 'session.json'), 'utf8')) as ChessSessionCheckpoint;
  const journal = JSON.parse(await readFile(join(bootstrap, 'learning/revisions.json'), 'utf8')) as RevisionJournal<ChessPolicy>;
  candidate = journal.artifacts.find(item => item.revision.version === journal.active.revision.version && item.revision.id === journal.active.revision.id)!;
  originalBaseline = journal.artifacts.find(item => item.revision.version === journal.initial.version && item.revision.id === journal.initial.id);
  assert.ok(candidate && originalBaseline, 'Learning journal is missing an active or baseline artifact');
  const evidence = observeChessLearning(saved, undefined, { bootstrap: true, revision: journal.active.revision });
  assert.ok(evidence, 'Evaluation requires an observable session at a completed gameplay boundary');
  incidentMark = { evidence, origin: { activation: journal.active, context: contentRevision('chess-user-context', { objective: saved.objective, profile: saved.policy, adapter: candidate.adapter }) } };
  frozenView = { mainId: saved.mainId, objective: saved.objective, worlds: saved.worlds.map(world => ({ id: world.meta.id, state: world.state })) };
} else {
  frozenView = JSON.parse(await readFile(resolve(args[1]!), 'utf8'));
  candidate = (JSON.parse(await readFile(join(bootstrap, 'proposal.json'), 'utf8')) as { artifact: LearningRevision<ChessPolicy> }).artifact;
}
const main = frozenView.worlds.find(world => world.id === frozenView.mainId);
assert.ok(main && main.state.moves.length >= 8, 'Provide a saved main run with at least eight observed plies');
const source = await originalStore.get(candidate.executor);
const directory = resolve(`artifacts/chess-strategy-evaluation/${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) => new JsonFileStore(join(directory, name), data => data).save(value);
const store = new ExecutableStore(join(directory, 'sources'));
assert.deepEqual((await store.put(source.source)).revision, candidate.executor);
const base = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `export default input => ({abi:'chess-preparation/1',guidance:'',plans:input.candidates.map(p=>({id:p.id,label:p.label,expectedBenefit:p.expectedBenefit})),experienceIndices:input.experience.map((_,i)=>i)});` } });
const { revision: _revision, ...fields } = candidate;
const data = { ...fields, executor: base.revision }, baseline = originalBaseline ?? { ...data, revision: contentRevision('chess-learning-system', data) };
if (originalBaseline) assert.deepEqual((await store.put((await originalStore.get(originalBaseline.executor)).source)).revision, originalBaseline.executor);
const evaluatorPaths = fullHarness
  ? (await Promise.all(['examples/chess', 'harness/src'].map(async root => (await readdir(root, { recursive: true })).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts')).map(path => join(root, path))))).flat().sort()
  : ['examples/chess/incident-contract.ts', 'examples/chess/comparison-summary.ts', 'examples/chess/strategy-evaluation.ts', 'examples/chess/decision.ts', 'examples/chess/adapter.ts', 'examples/chess/runtime.ts', 'examples/chess/jev.ts'];
const evaluator = contentRevision(fullHarness ? 'chess-full-harness-evaluator' : 'chess-single-path-evaluator', await Promise.all(evaluatorPaths.map(async path => ({ path, source: await readFile(path, 'utf8') }))));
const plies = 8;
const singlePathContract: EvaluationContract<ChessStrategyScenario> = frozenContract ? { ...frozenContract, evaluator } : incidentMark ? { ...chessIncidentContract(incidentMark), evaluator } : {
  id: 'chess-prepared-strategy-comparison-v1', evaluator, scenarios: [
    { id: 'ordinary-opening', seed: 'opening-history', input: { saved: { initialFen: DEFAULT_POSITION, moves: [] }, objective: frozenView.objective, player: 'w', plies } },
    { id: 'before-live-repetition', seed: 'frozen-live-history', input: { saved: { initialFen: main.state.initialFen, moves: main.state.moves.slice(0, -8) }, objective: frozenView.objective, player: 'w', plies } },
  ], budget: { simulationUnit: 'chess-plies', limits: { simulation: plies, modelCalls: plies, executorCalls: plies } }, maxRunMs: 180000,
  acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: .1, maximumCaseRegression: 0 },
};
// A separately identified contract counts discarded futures too; historical single-path receipts remain unchanged.
const contract = fullHarness ? chessHarnessContract(singlePathContract, baseline.policy) : singlePathContract;
const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
const records: ExecutorRunRecord[] = [];
const recordStore = new JsonFileStore<ExecutorRunRecord[]>(join(directory, 'executor-runs.json'), value => value as ExecutorRunRecord[]);
const executor = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  const index = records.findIndex(item => item.id === record.id);
  if (index < 0) records.push(record); else records[index] = record;
  await recordStore.save(records);
} });
const limits = { timeoutMs: 20000, cpus: 1, memoryMiB: 256, maxInputBytes: 65536, maxOutputBytes: 65536 };
const control = new AbortController();
process.once('SIGINT', () => control.abort(new Error('Evaluation cancelled')));
process.once('SIGTERM', () => control.abort(new Error('Evaluation cancelled')));
await save('manifest.json', { baseline, candidate, contract, sourceRun: bootstrap, frozenView, image: `docker.io/library/node@${image.manifestDigest}`, limits,
  mode: qualify ? 'full-harness-qualification' : fullHarness ? 'full-harness' : 'single-path', implementation: evaluator,
  limitations: [fullHarness ? 'Full session decision, future exploration and promotion under matched total work allowances; no activation.' : 'Single-path strategy/Jev comparison; no future-search policy qualification or activation.', 'The opponent uses frozen baseline preparation and Jev in both roles.', 'Scenario seeds identify identical saved board histories; Jev sampling is not seed-controlled.', 'Short repeated cases cannot establish general chess strength or statistical confidence. Game state uses chess.js, preparation uses real VMs.'] });
console.log(JSON.stringify({ stage: 'started', directory }));
try {
  const model: Parameters<typeof compareChessEvaluation>[0]['model'] = async (artifact, ledger, runId) => {
    const decision = await ChessJevModel.open(join(directory, runId, 'jev'));
    assert.deepEqual(artifact.model, contentRevision('chess-prepared-jev', { abi: 'chess-preparation/1', decision: decision.version }));
    return new ChessPreparedModel(artifact, { store, executor, ledger, limits, decision, record: value => save(`${runId}/preparation-${randomUUID()}.json`, value) });
  };
  let report: Awaited<ReturnType<typeof compareChessEvaluation>>;
  if (qualify) {
    const context = contentRevision('chess-diagnostic-context', { objective: frozenView.objective });
    const options: Parameters<typeof openChessStrategyLearning>[0] = { directory: join(directory, 'learning'), baseline, store, contract,
      context: () => context, objective: () => frozenView.objective, boundary: work => work(), evaluationModel: model,
      liveModel: () => { throw new Error('Standalone qualification must not open a live model'); } };
    const owner = await openChessStrategyLearning(options), id = 'saved-source';
    await owner.controller.submit({ id, candidate, reason: 'Qualify saved source through the full gameplay loop', expiresAt: Date.now() + 3600000 });
    const qualification = await owner.controller.evaluate(id, control.signal); await owner.controller.join();
    await save('qualification.json', qualification);
    report = JSON.parse(await readFile(join(directory, 'learning/evaluations', id, 'comparison.json'), 'utf8'));
    const restored = await openChessStrategyLearning(options);
    assert.deepEqual(restored.controller.snapshot(), owner.controller.snapshot()); assert.equal(restored.controller.active.epoch, 0);
    await save('controller-reconnect.json', { sameJournal: true, activationEpoch: 0, noLiveModel: true });
  } else report = await compareChessEvaluation({ directory: join(directory, 'harness'), contract, baseline, candidate, model,
    persistence: { persistBudget: (id, value) => save(`runs/${id}-budget.json`, value), persistRun: async run => {
    await save(`runs/${run.id}-result.json`, run);
    console.log(JSON.stringify({ stage: 'run-complete', scenario: run.scenarioId, role: run.role, status: run.status, metrics: run.metrics, error: run.error }));
  } } }, control.signal);
  await save('comparison.json', report);
  await save('summary.json', summarizeChessComparison(report));
  assert.ok(records.every(record => record.phase === 'released'));
  for (const record of records) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  await save('cleanup.json', { vmCount: records.length, allReleasedAndAbsent: true });
  console.log(JSON.stringify({ stage: 'complete', directory, accepted: report.accepted, reason: report.reason, meanGain: report.meanGain, vmCount: records.length }));
} finally { for (const record of records.filter(item => item.phase !== 'released')) await executor.recover(record); }
