import '../runtime-env.ts';
import '../build-bridge.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Image } from 'microsandbox';
import { BudgetLedger, RevisionController, canonicalJson, compareRevisions, type BudgetSnapshot, type EvaluationContract, type ExecutorLimits, type LearningRevision, type RevisionJournal, type RevisionPorts } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { Session } from '../../examples/doom/server/src/session.ts';
import { SessionStore } from '../../examples/doom/server/src/persistence.ts';
import { Recordings } from '../../examples/doom/server/src/recordings.ts';
import { createWorld, reconnectWorld, recoverPendingWorld, destroyWorld, type WorldRuntime } from '../../examples/doom/server/src/runtime.ts';
import { checkpoints } from '../../examples/doom/server/src/checkpoints.ts';
import { doomLearningBinding } from '../../examples/doom/server/src/doom-learning.ts';
import { DoomExecutableModel } from '../../examples/doom/server/src/doom-executor-model.ts';
import { actions } from '../../examples/doom/server/src/jev.ts';
import { parseDoomLearningPolicy, type DoomPolicy } from '../../examples/doom/server/src/doom-policy.ts';
import type { GameState } from '../../examples/doom/contracts/src/game.ts';

// Controlled navigation integration: real Doom VMs and isolated TS, not autonomous discovery or level-completion quality.
const phase = process.argv[2];
if (!phase) {
  const root = resolve(`artifacts/doom-revision-qualification/${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(root, { recursive: true });
  for (const next of ['prepare', 'resume', 'rollback']) {
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, next, root], { stdio: 'inherit' });
      child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Doom ${next} failed: ${code ?? signal}`)));
    });
  }
  console.log(JSON.stringify({ root, result: 'Doom executable activation, detached restart, exact checkpoint rollback and replay verified in three processes' }));
} else {
  if (!['prepare', 'resume', 'rollback'].includes(phase) || !process.argv[3]) throw new Error('Invalid Doom qualification phase');
  await run(phase, resolve(process.argv[3]));
  process.exit(0); // Detached game VMs deliberately outlive prepare/resume hosts.
}
interface Manifest { rootId: string; image: string; builds: Record<string, string>; baseline: LearningRevision<DoomPolicy>; candidate: LearningRevision<DoomPolicy>;
  contract: EvaluationContract<null>; limits: ExecutorLimits }
async function run(phase: string, root: string): Promise<void> {
  const write = <T>(file: string, data: T) => new JsonFileStore(join(root, file), value => value as T).save(data);
  const artifacts = new ExecutableStore(join(root, 'executables'));
  const manifestStore = new JsonFileStore(join(root, 'manifest.json'), value => value as Manifest);
  const sourceRoots = ['examples/doom/server/src', 'examples/doom/contracts/src', 'examples/doom/bridge/src', 'packages/executor-microsandbox/src', 'harness/src'];
  const files = ['assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'dist/bridge.mjs', 'package-lock.json', 'scripts/qualification/doom-revisions.ts',
    ...(await Promise.all(sourceRoots.map(async path => (await readdir(path, { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => join(path, file))))).flat()].sort();
  const builds = Object.fromEntries(await Promise.all(files.map(async file => {
    const bytes = await readFile(file);
    if (phase === 'prepare' && !file.startsWith('assets/')) { const target = join(root, 'source', file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    return [file, createHash('sha256').update(bytes).digest('hex')];
  })));
  let manifest = await manifestStore.load();
  const options = { threshold: .75, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 };
  const noFallback = { decide: async () => { throw new Error('Bound executable must supply the decision'); } };
  if (phase === 'prepare') {
    if (manifest) throw new Error('Doom qualification directory already exists');
    const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
    const policy = new Session(noFallback, options).learningPolicy(); policy.planningMode = 'actions'; policy.decisionTicks = 7;
    const artifact = async (target: 'wait' | 'advance') => {
      const code = await artifacts.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts':
        `export default input => { const selected = (input.candidates.find(c => c.id === ${JSON.stringify(target)}) ?? input.candidates[0]).id; return { selected, confidence: 1, priority: 'exploration', preferences: input.candidates.map(c => ({id:c.id, probability:c.id===selected?1:0})) }; };` } });
      const data = { policy, prompts: {}, skills: [], executor: code.revision, adapter: contentRevision('doom-learning-adapter', builds), model: { id: 'isolated-doom-ranking', version: '1' } };
      return { ...data, revision: contentRevision('doom-learning', data) };
    };
    manifest = { rootId: `mom-learning-${randomUUID().slice(0, 12)}`, image: `docker.io/library/node@${image.manifestDigest}`, builds,
      baseline: await artifact('wait'), candidate: await artifact('advance'),
      limits: { timeoutMs: 10000, cpus: 1, memoryMiB: 256, maxInputBytes: 131072, maxOutputBytes: 16384 },
      contract: { id: 'doom-navigation-contract-v1', evaluator: contentRevision('host-live-displacement', builds),
        scenarios: [{ id: 'spawn', seed: 'same-physical-snapshot', input: null }],
        budget: { simulationUnit: 'doom-ticks', limits: { simulation: 14, executorCalls: 1, modelCalls: 0 } }, maxRunMs: 30000,
        acceptance: { metric: 'progress', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } } };
    await manifestStore.save(manifest);
    await write('limitations.json', ['Hand-authored wait/advance source fixtures, not autonomous source proposals.', 'One controlled navigation start. Displacement with a damage penalty is not a level-completion or strong-gameplay benchmark.', 'Both Doom and candidate code use real VMs. Checkpoint/replay recovery is tested independently of candidate quality.', 'Source execution has fixed allocations and deadlines, not an exact CPU-time budget.']);
  }
  assert.ok(manifest); assert.deepEqual(builds, manifest.builds);
  const { baseline, candidate, contract, limits } = manifest;
  const recordStore = new JsonFileStore(join(root, 'executor-runs.json'), value => value as ExecutorRunRecord[]);
  const runs = new Map((await recordStore.load() ?? []).map(record => [record.id, record]));
  const executor = new MicrosandboxExecutor({ image: manifest.image, record: async record => { runs.set(record.id, record); await recordStore.save([...runs.values()]); } });
  const budgetStore = new JsonFileStore(join(root, 'live-budget.json'), value => value as BudgetSnapshot);
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 77, executorCalls: 10, modelCalls: 0 } }, value => budgetStore.save(value), await budgetStore.load());
  // Meter every live future and the 35-tick bootstrap, not only the selected route.
  const meter = (runtime: WorldRuntime): WorldRuntime => ({
    id: runtime.id, identity: runtime.identity, state: () => runtime.state(), frame: () => runtime.frame(), destroy: () => runtime.destroy(),
    step: command => ledger.run({ owner: runtime.id, operation: 'live-game-input', reserve: { simulation: command.ticks } }, async () => ({
      value: await runtime.step(command), usage: { simulation: command.ticks } })),
    branch: async ids => (await runtime.branch(ids)).map(meter),
    ...(runtime.captureCheckpoint ? { captureCheckpoint: (reference: string) => runtime.captureCheckpoint!(reference) } : {}),
  });
  const model = (revision: LearningRevision<DoomPolicy>, budget = ledger) => new DoomExecutableModel(revision, { store: artifacts, executor, ledger: budget, limits,
    record: async result => { assert.equal((result.input as { learning: { policy: DoomPolicy } }).learning.policy.forkThreshold, .5); await write(`decisions/${randomUUID()}.json`, result); } });
  const store = new SessionStore(join(root, 'session.json'));
  const journal = new JsonFileStore(join(root, 'supervisor.json'), value => value as RevisionJournal<DoomPolicy>);
  const recordings = new Recordings(join(root, 'recordings')); await recordings.open();
  let session: Session | undefined;
  const rules = { contract: contentRevision('doom-evaluation', contract), capabilities: ['executor'] as Array<'executor'>, maxLifetimeMs: 3600000 };
  const ports: RevisionPorts<DoomPolicy> = {
    context: () => session?.supervisorContext() ?? contentRevision('unattached-doom', { root }), boundary: work => session!.revisionBoundary(work), persist: value => journal.save(value),
    verify: async artifact => { assert.ok([baseline, candidate].some(value => canonicalJson(value) === canonicalJson(artifact))); parseDoomLearningPolicy(artifact.policy); await artifacts.get(artifact.executor); },
    compatible: async (_before, after) => session!.validateLearningRevision(after),
    qualify: async (request, signal) => {
      const source = await reconnectWorld(session!.snapshot().mainId, session!.checkpoint().worlds.find(world => world.view.id === session!.snapshot().mainId)!.identity!);
      const original = await source.state();
      const report = await compareRevisions<null, { before: GameState; after: GameState }>(contract, request.baseline.revision, request.candidate.revision, {
        run: async (ref, _scenario, budget, current) => {
          current.throwIfAborted(); const revision = [baseline, candidate].find(value => value.revision.version === ref.version)!;
          const [world] = await source.branch([`${manifest!.rootId}-evaluation-${randomUUID().slice(0, 8)}`]); assert.ok(world);
          try {
            const before = await world.state(); assert.deepEqual(before, original);
            const choice = await model(revision, budget).decide(before, session!.snapshot().objective, [before], current, [], 14, { policy: session!.learningPolicy() });
            const after = await budget.run({ owner: world.id, operation: 'bounded-game-input', reserve: { simulation: 14 } }, async () => ({
              value: await world.step({ ticks: 14, inputs: actions[choice.action].inputs }), usage: { simulation: 14 } }), current);
            return { ending: 'budget', evidence: { before, after } };
          } finally { await world.destroy(); }
        },
        measure: ({ before, after }) => ({ progress: after.alive ? Math.hypot(after.x - before.x, after.y - before.y) - Math.max(0, before.health - after.health) * 100 : -1000000 }),
        persistBudget: (id, value) => write(`evaluation/${id}-budget.json`, value), persistRun: value => write(`evaluation/${value.id}.json`, value),
      }, signal);
      assert.deepEqual(await source.state(), original, 'evaluation did not advance the live source'); await write('comparison.json', report);
      return { baseline: request.baseline.revision, candidate: request.candidate.revision, context: request.context, contract: request.contract,
        accepted: report.accepted, reason: report.reason, evidence: { comparison: contentRevision('doom-comparison', report) } };
    },
  };
  const controller = phase === 'prepare' ? await RevisionController.create(baseline, rules, ports) : await RevisionController.restore((await journal.load())!, rules, ports);
  session = new Session(noFallback, options, doomLearningBinding(controller, contentRevision('doom-journal', { root }), revision => model(revision)));
  session.setCheckpointAdapter({ ...checkpoints, restore: async (reference, id) => meter(await checkpoints.restore(reference, id)) }); session.setPersistence(value => store.save(value));
  session.setRecorder((world, frame) => recordings.record(world, frame)); session.setMainRecorder(id => recordings.retainPath(id));
  let success = false;
  try {
    if (phase === 'prepare') {
      const runtime = await ledger.run({ owner: manifest.rootId, operation: 'game-bootstrap', reserve: { simulation: 35 } }, async () => {
        const runtime = await createWorld(manifest!.rootId, { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 });
        try { const tick = (await runtime.state()).tick; assert.equal(tick, 35); return { value: runtime, usage: { simulation: tick } }; }
        catch (error) { await runtime.destroy(); throw error; }
      });
      await session.initialize(meter(runtime)); session.setForkThreshold(.5);
    } else await session.restore((await store.load())!, async (id, identity) => meter(await reconnectWorld(id, identity)), async id => {
      const runtime = await recoverPendingWorld(id); return runtime ? meter(runtime) : undefined;
    }, destroyWorld);
    assert.equal(session.snapshot().forkThreshold, .5, 'explicit user override survives every activation/restart');
    const play = async () => { session!.step(); await session!.idle(); assert.equal(session!.snapshot().error, undefined); assert.equal(session!.snapshot().stage, 'choosing');
      session!.step(); await session!.idle(); assert.equal(session!.snapshot().error, undefined); };
    if (phase === 'prepare') {
      await controller.submit({ id: 'move', candidate, reason: 'Controlled navigation qualification', expiresAt: Date.now() + 3600000 });
      assert.equal((await controller.evaluate('move')).status, 'qualified');
      await play(); await session.saveRecoveryCheckpoint();
      await write('checkpoint-proof.json', { point: session.snapshot().recovery!.checkpoints[0], world: session.snapshot().worlds.find(world => world.id === session!.snapshot().mainId), frame: session.frame(session.snapshot().mainId).toString('base64') });
      await controller.activate('move'); assert.equal(controller.active.epoch, 1);
    } else if (phase === 'resume') {
      assert.equal(controller.active.epoch, 1); await play();
      const world = session.snapshot().worlds.find(world => world.id === session!.snapshot().mainId)!;
      assert.equal(world.learning?.activation.epoch, 1); assert.deepEqual(world.learning.executor, candidate.executor);
      await recordings.flush(); const replay = await recordings.path(world.id); assert.equal(replay.missingHistory, false);
      await write('candidate-continuation.json', { world, replay });
      await controller.rollback(baseline.revision, 'Restore original learning executable');
      const proof = JSON.parse(await readFile(join(root, 'checkpoint-proof.json'), 'utf8'));
      await session.rollback(proof.point.id);
      const restored = session.snapshot().worlds.find(world => world.id === session!.snapshot().mainId)!;
      assert.deepEqual(restored.state, proof.world.state); assert.equal(session.frame(restored.id).toString('base64'), proof.frame);
      assert.equal(restored.learning?.activation.epoch, 0);
      await recordings.flush(); assert.equal((await recordings.path(restored.id)).lastTick, proof.world.state.tick);
    } else {
      assert.equal(controller.active.epoch, 2); await play();
      assert.equal(session.snapshot().decision?.learning?.activation.epoch, 2);
      assert.deepEqual(session.snapshot().decision?.learning?.executor, baseline.executor);
    }
    await session.pause(); await recordings.flush(); await ledger.join();
    assert.ok([...runs.values()].every(record => record.phase === 'released'));
    await write(`${phase}.json`, { pid: process.pid, epoch: controller.active.epoch, session: session.checkpoint(), executorInvocations: runs.size });
    if (phase === 'rollback') { assert.equal(ledger.used('simulation'), 77); await session.close(); await recordings.flush(); await write('cleanup.json', session.checkpoint()); }
    success = true; console.log(JSON.stringify({ phase, pid: process.pid, epoch: controller.active.epoch, executorInvocations: runs.size }));
  } finally {
    if (!success) await session.close();
    await Promise.all([...runs.values()].filter(record => record.phase !== 'released').map(record => executor.recover(record)));
  }
}
