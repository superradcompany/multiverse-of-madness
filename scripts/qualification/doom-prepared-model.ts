import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { BudgetLedger, canonicalJson } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { DoomLearningModels, doomLearningArtifact } from '../../examples/doom/server/src/doom-learning-models.ts';
import { DoomPreparedModel } from '../../examples/doom/server/src/doom-prepared-model.ts';
import { DoomEvaluationVms, decodeDoomEvaluationVms } from '../../examples/doom/server/src/doom-evaluation-vms.ts';
import { microsandboxEvaluationVmPorts } from '../../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import { readDoomLearningBuild, retainDoomLearningBuild } from '../../examples/doom/server/src/doom-learning-build.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../../examples/doom/server/src/doom-navigation.ts';
import { decodeDoomProposal } from '../../examples/doom/server/src/doom-supervisor-proposal.ts';
import { defaultDoomOutcomeWeights, scoreDoomOutcome } from '../../examples/doom/server/src/doom-outcome.ts';
import { Session } from '../../examples/doom/server/src/session.ts';

// Component integration with authored or unchanged supervisor-proposed source. No improvement claim.
const root = resolve(`artifacts/doom-prepared-model/${new Date().toISOString().replaceAll(':', '-')}`);
const stores = new Map<string, JsonFileStore<unknown>>();
const save = (file: string, value: unknown) => {
  let store = stores.get(file); if (!store) { store = new JsonFileStore(join(root, file), value => value); stores.set(file, store); } return store.save(value);
};
const build = await readDoomLearningBuild(); await retainDoomLearningBuild(join(root, 'build'), build);
const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
const pinned = `docker.io/library/node@${image.manifestDigest}`;
const resources = { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 };
const owner = await DoomEvaluationVms.open(new JsonFileStore(join(root, 'resources.json'), decodeDoomEvaluationVms), microsandboxEvaluationVmPorts({ image: pinned, resources }));
const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 140, modelCalls: 8, executorCalls: 8 } }, value => save('budget.json', value));
const records = new Map<string, ExecutorRunRecord>();
const executor = new MicrosandboxExecutor({ image: pinned, record: async record => { records.set(record.id, record); await save('executor-runs.json', [...records.values()]); } });
const executables = new ExecutableStore(join(root, 'executables'));
const proposalDirectory = process.argv.find(arg => arg.startsWith('--proposal='))?.slice(11);
const proposal = proposalDirectory ? decodeDoomProposal(JSON.parse(await readFile(join(resolve(proposalDirectory), 'proposal.json'), 'utf8'))) : undefined;
if (proposal) { assert.equal(proposal.status, 'submitted'); assert.equal(proposal.candidate?.model.id, 'prepared-doom-jev'); }
const source = await executables.put(proposal
  ? (await new ExecutableStore(join(resolve(proposalDirectory!), 'executables')).get(proposal.candidate!.executor)).source
  : { format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': await readFile('scripts/qualification/fixtures/doom-preparation.ts', 'utf8') } });
if (proposal) assert.deepEqual(source.revision, proposal.candidate!.executor);
let apiCalls = 0, preparations = 0;
const client = new TypeSafeClient({ timeout: 10000, retry: { maxRetries: 0 }, fetch: async (url, init) => {
  const id = ++apiCalls; assert.equal(typeof init?.body, 'string');
  await save(`requests/${id}.json`, JSON.parse(init!.body as string));
  const response = await fetch(url, init); await save(`responses/${id}.json`, { status: response.status, body: await response.clone().json() }); return response;
} });
const models = new DoomLearningModels({ adapter: build.revision, builtinExecutor: { id: 'unused', version: '1' }, profile: 'game-aware', executables, client,
  executable: artifact => new DoomPreparedModel(artifact, { store: executables, executor, ledger, client,
    limits: { timeoutMs: 10000, cpus: 1, memoryMiB: 256, maxInputBytes: 1048576, maxOutputBytes: 16384 },
    record: record => save(`preparations/${++preparations}.json`, record) }) });
const policy = proposal ? structuredClone(proposal.candidate!.policy) : new Session({ decide: async () => { throw new Error('No fallback decision'); } }).learningPolicy();
if (process.argv.includes('--shaping')) {
  policy.outcomeWeights = structuredClone(defaultDoomOutcomeWeights);
  for (const weights of Object.values(policy.outcomeWeights)) { weights.novelCells = 77; weights.items = 31; weights.ammo = .21; }
}
policy.planningMode = 'plans'; policy.trialTicks = 35; policy.decisionTicks = 35; policy.breadth = 2; policy.memory.enabled = true;
const artifact = doomLearningArtifact({ policy, adapter: build.revision, executor: source.revision, model: { id: 'prepared-doom-jev', version: 'jev-latest' }, prompts: proposal?.candidate!.prompts ?? {}, skills: proposal?.candidate!.skills ?? [] });
await models.verify(artifact);
const session = new Session(models.model(artifact), { threshold: .75, horizon: 35, branches: 2, paceMs: 0 }, {
  identity: contentRevision('prepared-qualification', artifact.revision), adapter: artifact.adapter,
  current: () => ({ activation: { epoch: 0, revision: artifact.revision }, artifact }),
  resolve: activation => { assert.equal(activation.epoch, 0); assert.deepEqual(activation.revision, artifact.revision); return artifact; }, model: current => { assert.equal(canonicalJson(current), canonicalJson(artifact)); return models.model(current); },
});
session.setPersistence(value => save('session.json', value));
session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
await save('manifest.json', { build, artifact, image: pinned, resources, proposalDirectory, originalCandidate: proposal?.candidate, limitation: 'Component integration only. Source bytes preserved; host adapter rebound to this build, and trial duration/breadth/mode fixed for this diagnostic. No independent performance comparison or improvement claim.' });
let result: Record<string, unknown>;
try {
  await session.initialize(await owner.create('prepared-gameplay', ledger, new AbortController().signal));
  session.step(); await session.idle();
  const view = session.snapshot(); assert.equal(view.error, undefined); assert.equal(view.stage, 'choosing'); assert.equal(view.comparison?.selected, false);
  assert.equal(view.worlds.filter(world => world.role === 'experiment').length, 2);
  assert.ok(view.decision?.preparation?.planIds.length);
  if (!proposal) assert.ok(view.decision!.preparation!.planIds.every(id => id.startsWith('learning_route_')));
  assert.ok(view.worlds.filter(world => world.role === 'experiment').every(world => world.state.tick >= 70));
  assert.ok(apiCalls > 0 && preparations === apiCalls);
  const saved = session.checkpoint();
  if (policy.outcomeWeights) {
    const reference = saved.view.decision!.policyRevision!;
    assert.deepEqual(saved.policies!.find(entry => entry.revision.version === reference.version)!.policy.values.outcomeWeights, policy.outcomeWeights);
    const main = saved.worlds.find(world => world.view.id === saved.view.mainId)!;
    for (const world of saved.worlds.filter(world => world.view.role === 'experiment')) {
      const novelty = Math.max(0, world.stats!.visited.length - main.stats!.visited.length);
      assert.equal(world.view.score, scoreDoomOutcome(saved.baseline!, world.view.state, saved.priority, novelty, policy.outcomeWeights));
    }
  }
  const candidate = view.comparison!.bestId; await session.promote(candidate);
  assert.equal(session.snapshot().mainId, candidate);
  result = { status: 'passed', shapingVerified: Boolean(policy.outcomeWeights), apiCalls, preparations, simulation: ledger.used('simulation'), modelCalls: ledger.used('modelCalls'), executorCalls: ledger.used('executorCalls'), selected: candidate };
} catch (error) {
  result = { status: 'failed', error: error instanceof Error ? error.message : String(error), apiCalls, preparations }; throw error;
} finally {
  try { await session.close(); } finally { await owner.recover(); for (const record of records.values()) if (record.phase !== 'released') await executor.recover(record); }
  await ledger.join();
  for (const record of records.values()) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  for (const run of owner.snapshot().runs) for (const world of run.worlds) await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError);
  await save('result.json', { ...result!, cleanupVerified: true });
}
console.log(JSON.stringify({ root, ...result! }));
