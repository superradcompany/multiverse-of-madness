import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Image } from 'microsandbox';
import { BudgetLedger, RevisionController, canonicalJson, compareRevisions, type BudgetSnapshot, type EvaluationContract, type LearningRevision, type RevisionJournal, type ExecutorLimits, type ExecutorReceipt, type RevisionPorts } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { ChessWorld, type ChessState } from '../../examples/chess/runtime.ts';
import { describeChess } from '../../examples/chess/description.ts';
import { ChessAdapter } from '../../examples/chess/adapter.ts';
import { ChessExecutableModel, type ChessExecutorDecision } from '../../examples/chess/executor-model.ts';
import { defaultChessPolicy } from '../../examples/chess/policy.ts';
import { chessLearningBinding } from '../../examples/chess/revisions.ts';
import { ChessRuntimeStore } from '../../examples/chess/runtime-store.ts';
import { ChessSession } from '../../examples/chess/session.ts';
import { generateChessRevision, type TrainingObservation } from './supervisor-proposal.ts';
import type { ChessPolicy } from '../../examples/chess/session-types.ts';

// Independent host evaluation. Autonomous mode generates source; neither mode establishes broad chess strength.
const autonomous = process.argv.includes('--autonomous');
const phase = process.argv[2] === '--autonomous' ? undefined : process.argv[2];
if (!phase) {
  const directory = resolve(`artifacts/executable-qualification/${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(directory, { recursive: true });
  let accepted = true;
  for (const next of ['prepare', 'resume', 'rollback']) {
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, next, directory, ...(autonomous ? ['--autonomous'] : [])], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Qualification ${next} failed: ${code ?? signal}`)));
    });
    if (next === 'prepare' && JSON.parse(await readFile(join(directory, 'prepare.json'), 'utf8')).accepted === false) { accepted = false; break; }
  }
  console.log(JSON.stringify({ output: directory, autonomous, processes: accepted ? 3 : 1, result: accepted ? 'qualified, activated, continued after restart, rolled back and continued after another restart' : 'proposal rejected; baseline retained' }));
} else {
  if (!['prepare', 'resume', 'rollback'].includes(phase) || !process.argv[3]) throw new Error('Invalid qualification phase/directory');
  await qualify(phase, resolve(process.argv[3]));
}

interface Manifest {
  image: string;
  builds: Record<string, string>;
  contract: EvaluationContract<{ fen: string }>;
  limits: ExecutorLimits;
  baseline: LearningRevision<ChessPolicy>;
  invalid: LearningRevision<ChessPolicy>;
  improved?: LearningRevision<ChessPolicy>;
  autonomous: boolean;
}
async function qualify(phase: string, root: string): Promise<void> {
  const write = <T>(name: string, value: T) => new JsonFileStore(join(root, name), value => value as T).save(value);
  const adapter = new ChessAdapter(), policy: ChessPolicy = { ...defaultChessPolicy, threshold: 0 };
  const artifacts = new ExecutableStore(join(root, 'executables'));
  const manifestStore = new JsonFileStore(join(root, 'manifest.json'), value => value as Manifest);
  const sources = await Promise.all(['harness/src', 'examples/chess', 'packages/executor-microsandbox/src', 'packages/supervisor-claude/src'].map(async directory =>
    (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => join(directory, file))));
  const files = [...sources.flat(), 'node_modules/chess.js/dist/cjs/chess.js', 'scripts/qualification/executable-revisions.ts', 'scripts/qualification/supervisor-proposal.ts', 'package-lock.json'].sort();
  const builds = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  let manifest = await manifestStore.load();
  if (phase === 'prepare') {
    if (manifest) throw new Error('Qualification output already exists');
    const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
    const make = async (source: string): Promise<LearningRevision<ChessPolicy>> => {
      const code = await artifacts.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': source } });
      const data = { executor: code.revision, adapter: adapter.version, policy, prompts: {}, skills: [], model: { id: 'isolated-chess-code-fixture', version: '1' } };
      return { ...data, revision: contentRevision('chess-learning-system', data) };
    };
    const source = (selection: string) => `export default input => { const selected = ${selection}; return { selected, confidence: 1, preferences: input.candidates.map(p => ({ id: p.id, probability: p.id === selected ? 1 : 0 })) }; };`;
    const baseline = await make(source('input.candidates[0].id'));
    const invalid = await make('export default () => ({ selected: "illegal-move", confidence: 1, preferences: [], checkmates: 999 });');
    const improved = autonomous ? undefined : await make(source('(input.candidates.find(p => p.payload.san.endsWith("#")) ?? input.candidates[0]).id'));
    const fens = ['7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', 'k7/2Q5/1K6/8/8/8/8/8 w - - 0 1', '8/8/8/8/8/6k1/5q2/7K b - - 0 1'];
    manifest = { autonomous, builds, image: `docker.io/library/node@${image.manifestDigest}`, baseline, invalid, ...(improved ? { improved } : {}),
      limits: { timeoutMs: 10_000, cpus: 1, memoryMiB: 256, maxInputBytes: 32_768, maxOutputBytes: 16_384 },
      contract: { id: 'chess-executor-contract-v2', evaluator: contentRevision('host-checkmate', builds),
        scenarios: fens.map((fen, i) => ({ id: `mate-${i}`, seed: `fixed-position-${i}`, input: { fen } })),
        budget: { simulationUnit: 'chess-plies', limits: { simulation: 1, modelCalls: 0, executorCalls: 1 } }, maxRunMs: 15_000,
        acceptance: { metric: 'checkmates', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } } };
    await manifestStore.save(manifest);
    await write('limitations.json', [autonomous ? 'One Claude-generated proposal from two training traces; no human source edits after generation.' : 'Controlled source fixtures, not autonomous discovery.', 'Handselected mate-in-one cases withheld from the proposal request, not a broad chess-strength benchmark.', 'Game worlds use chess.js/file-backed clones; candidate code uses real isolated VMs.', 'Calls, simulation and VM allocations/deadlines are capped; wall time is observed, not an exact CPU budget.']);
  }
  if (!manifest) throw new Error('Missing qualification manifest');
  assert.deepEqual(builds, manifest.builds);
  assert.equal(manifest.autonomous, autonomous);
  const { contract, baseline, invalid, limits } = manifest;
  let improved = manifest.improved;
  const recordsStore = new JsonFileStore(join(root, 'executor-runs.json'), value => value as ExecutorRunRecord[]);
  const records = new Map((await recordsStore.load() ?? []).map(record => [record.id, record]));
  const executor = new MicrosandboxExecutor({ image: manifest.image, record: async record => { records.set(record.id, record); await recordsStore.save([...records.values()]); } });
  const journalStore = new JsonFileStore(join(root, 'supervisor.json'), value => value as RevisionJournal<ChessPolicy>);
  const liveBudgetStore = new JsonFileStore(join(root, 'continuation-budget.json'), value => value as BudgetSnapshot);
  const liveLedger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: { simulation: 3, executorCalls: 3, modelCalls: 0 } }, value => liveBudgetStore.save(value), await liveBudgetStore.load());
  const makeModel = (revision: LearningRevision<ChessPolicy>, ledger: BudgetLedger, observed?: (decision: ChessExecutorDecision) => void) => new ChessExecutableModel(revision, {
    store: artifacts, executor, ledger, limits, record: async decision => { await write(`decisions/${randomUUID()}.json`, decision); observed?.(decision); },
  });
  let session: ChessSession | undefined;
  const context = contentRevision('chess-user-context', { objective: 'win by checkmate', profile: policy, adapter: adapter.version });
  const rules = { contract: contentRevision('chess-evaluation', contract), capabilities: ['executor'] as Array<'executor'>, maxLifetimeMs: 3_600_000 };
  type Evidence = { before: ChessState; after: ChessState; execution: ExecutorReceipt };
  const ports: RevisionPorts<ChessPolicy> = {
    context: () => session?.supervisorContext() ?? context,
    boundary: work => { if (!session) throw new Error('Attach the live session before activation'); return session.revisionBoundary(work); },
    persist: value => journalStore.save(value),
    verify: async artifact => {
      const { revision, ...data } = artifact;
      assert.deepEqual(revision, contentRevision(revision.id, data));
      assert.ok([baseline, invalid, manifest!.improved].some(item => item && canonicalJson(item) === canonicalJson(artifact)));
      await artifacts.get(artifact.executor);
    },
    compatible: async (before, after) => { assert.deepEqual(before.adapter, after.adapter); assert.deepEqual(after.policy, policy); },
    qualify: async (request, signal) => {
      const report = await compareRevisions(contract, request.baseline.revision, request.candidate.revision, {
        run: async (revision, scenario, ledger, current) => {
          const selected = [request.baseline, request.candidate].find(item => canonicalJson(item.revision) === canonicalJson(revision)); assert.ok(selected);
          const world = new ChessWorld(`${scenario.id}-${revision.version.slice(-8)}`, { initialFen: scenario.input.fen, moves: [] });
          try {
            const before = await world.state(); let execution: ExecutorReceipt | undefined;
            const choice = await makeModel(selected, ledger, record => { execution = record.receipt; }).decide({ state: before, objective: 'win by checkmate',
              candidates: await adapter.candidates(before), experience: [], revision: selected.revision }, current);
            const after = await ledger.run({ owner: world.id, operation: 'play-move', reserve: { simulation: 1 } }, async () => ({ value: await world.step({ san: choice.selected }), usage: { simulation: 1 } }), current);
            assert.ok(execution); return { ending: 'budget', evidence: { before, after, execution } };
          } finally { await world.destroy(); }
        },
        measure: (evidence: Evidence) => ({ checkmates: Number(evidence.after.status === 'checkmate' && evidence.after.turn !== evidence.before.turn) }),
        persistBudget: (id, value) => write(`${request.proposalId}/${id}-budget.json`, value), persistRun: value => write(`${request.proposalId}/${value.id}-result.json`, value),
      }, signal);
      await write(`${request.proposalId}/comparison.json`, report);
      return { baseline: report.baseline, candidate: report.candidate, context: request.context, contract: request.contract, accepted: report.accepted, reason: report.reason, evidence: { comparison: contentRevision('comparison', report) } };
    },
  };
  const controller = phase === 'prepare' ? await RevisionController.create(baseline, rules, ports) : await RevisionController.restore((await journalStore.load())!, rules, ports);
  const binding = chessLearningBinding(controller, contentRevision('chess-supervisor-journal', { root }), revision => makeModel(revision, liveLedger));
  const directory = join(root, 'session'), provider = new ChessRuntimeStore(join(directory, 'runtime'), contract.scenarios[0]!.input.fen);
  const baseModel = makeModel(baseline, liveLedger);
  const main = () => { const saved = session!.snapshot(); return saved.worlds.find(world => world.meta.id === saved.mainId)!; };
  const play = () => liveLedger.run({ owner: 'live-session', operation: 'live-input', reserve: { simulation: 1 } }, async () => {
    const before = main().state.ply; await session!.step(); assert.equal(main().state.ply, before + 1);
    return { value: main(), usage: { simulation: 1 } };
  });
  try {
    if (phase === 'prepare') {
      session = await ChessSession.create(directory, provider, adapter, baseModel, policy, binding);
      await controller.submit({ id: 'invalid-output', candidate: invalid, reason: 'Reject guest claims and illegal decisions', expiresAt: Date.now() + 3_600_000 });
      assert.equal((await controller.evaluate('invalid-output')).status, 'rejected');
      let origin: Parameters<typeof controller.submit>[0]['expected'];
      let reason = 'Prefer engine-identified mate over arbitrary legal moves';
      if (autonomous) {
        const trainingBudget = new BudgetLedger({ simulationUnit: 'chess-plies', limits: { simulation: 2, executorCalls: 2, modelCalls: 0 } }, value => write('training-budget.json', value));
        const observations: TrainingObservation[] = [];
        for (const [index, fen] of ['k7/8/1QK5/8/8/8/8/8 w - - 0 1', '8/8/8/8/8/5kq1/8/7K b - - 0 1'].entries()) {
          const world = new ChessWorld(`training-${index}`, { initialFen: fen, moves: [] });
          try {
            const before = await world.state();
            const decision = await makeModel(baseline, trainingBudget).decide({ state: before, objective: 'win by checkmate', candidates: await adapter.candidates(before), experience: [], revision: baseline.revision }, new AbortController().signal);
            const after = await trainingBudget.run({ owner: world.id, operation: 'training-input', reserve: { simulation: 1 } }, async () => ({ value: await world.step({ san: decision.selected }), usage: { simulation: 1 } }));
            observations.push({ before, selected: decision.selected, after });
          } finally { await world.destroy(); }
        }
        await write('training-observations.json', observations);
        const generated = await generateChessRevision({ directory: root, controller, context: session.supervisorContext(), contract: rules.contract, store: artifacts, observations, game: describeChess(adapter.version, provider.capabilities, adapter.player) }, new AbortController().signal);
        improved = generated.artifact; origin = generated.origin; reason = generated.reason;
        manifest.improved = improved; await manifestStore.save(manifest);
      }
      assert.ok(improved);
      await controller.submit({ id: 'recognize-mate', candidate: improved, reason, expiresAt: Date.now() + 3_600_000, ...(origin ? { expected: origin } : {}) });
      const evaluated = await controller.evaluate('recognize-mate');
      if (evaluated.status !== 'qualified' && autonomous) {
        await session.detach(); await write('prepare.json', { phase, pid: process.pid, accepted: false, status: evaluated.status, activation: controller.active, vmInvocations: records.size }); return;
      }
      assert.equal(evaluated.status, 'qualified');
      const before = await play(); assert.notEqual(before.state.status, 'checkmate');
      await write('baseline-continuation.json', before);
      await session.rollback(session.snapshot().points.points[0]!.id);
      await controller.activate('recognize-mate'); assert.equal(controller.active.epoch, 1);
    } else {
      session = await ChessSession.restore(directory, provider, adapter, baseModel, binding);
      assert.equal(controller.active.epoch, phase === 'resume' ? 1 : 2);
      const after = await play();
      assert.equal(after.provenance.learning?.epoch, controller.active.epoch);
      assert.deepEqual(after.provenance.executor, controller.current.executor);
      if (phase === 'resume') {
        assert.equal(after.state.status, 'checkmate');
        assert.equal((await session.replay()).missingHistory, false);
        assert.equal((await session.replayFrame(1)).world.provenance.learning?.epoch, 1);
        await write('improved-continuation.json', { world: after, replay: await session.replay() });
        await controller.rollback(baseline.revision, 'Return to the previously active executable');
        await session.rollback(session.snapshot().points.points[0]!.id);
      } else {
        assert.notEqual(after.state.status, 'checkmate'); assert.deepEqual(controller.current.executor, baseline.executor);
        assert.equal(controller.snapshot().history.length, 2); assert.equal(controller.snapshot().proposals.length, 2);
        assert.equal(session.snapshot().attempts.plies, 3); assert.equal(main().state.ply, 1);
        await write('rollback-continuation.json', { world: after, supervisor: controller.snapshot(), replay: await session.replay() });
      }
    }
    await session.detach(); await liveLedger.join();
    assert.ok([...records.values()].every(record => record.phase === 'released'));
    await write(`${phase}.json`, { phase, pid: process.pid, activation: controller.active, main: main().state, attemptedPlies: session.snapshot().attempts.plies, vmInvocations: records.size, cleanup: 'all released' });
    console.log(JSON.stringify({ phase, pid: process.pid, epoch: controller.active.epoch, mainPly: main().state.ply, vmInvocations: records.size, cleanup: 'all released' }));
  } finally { await Promise.all([...records.values()].filter(record => record.phase !== 'released').map(record => executor.recover(record))); }
}
