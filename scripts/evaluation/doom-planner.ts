import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Image, Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { BudgetLedger, EvaluationContract } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { DoomLearningModels, doomLearningArtifact } from '../../examples/doom/server/src/doom-learning-models.ts';
import { DoomPreparedModel } from '../../examples/doom/server/src/doom-prepared-model.ts';
import { decodeDoomProposal } from '../../examples/doom/server/src/doom-supervisor-proposal.ts';
import { readDoomLearningBuild, retainDoomLearningBuild } from '../../examples/doom/server/src/doom-learning-build.ts';
import { DoomVmEvaluations, type DoomVmScenario } from '../../examples/doom/server/src/doom-vm-evaluations.ts';
import { microsandboxEvaluationVmPorts } from '../../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import { doomSurvivalProgress } from '../../examples/doom/server/src/doom-revision-evaluation.ts';
import { decodeDoomEvaluationVms } from '../../examples/doom/server/src/doom-evaluation-vms.ts';
import type { DoomEvaluationContext } from '../../examples/doom/server/src/doom-revision-evaluation.ts';

// A fresh matched experiment, not a qualification under the original proposal's
// unrelated diagnostic contract. Neither revision is activated in any live game.
if (!process.argv[2]) throw new Error('Pass a submitted planner proposal directory');
const proposalDirectory = resolve(process.argv[2]);
const proposal = decodeDoomProposal(JSON.parse(await readFile(join(proposalDirectory, 'proposal.json'), 'utf8')));
assert.equal(proposal.status, 'submitted'); assert.equal(proposal.candidate?.model.id, 'prepared-doom-jev');
const root = resolve('artifacts/doom-planner-evaluation', new Date().toISOString().replaceAll(':', '-'));
const stores = new Map<string, JsonFileStore<unknown>>();
const save = (file: string, value: unknown) => {
  let store = stores.get(file); if (!store) { store = new JsonFileStore(join(root, file), input => input); stores.set(file, store); } return store.save(value);
};
const build = await readDoomLearningBuild(); await retainDoomLearningBuild(join(root, 'build'), build);
await copyFile(import.meta.filename, join(root, 'qualification.ts.source'));
const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
const pinned = `docker.io/library/node@${image.manifestDigest}`;
const resources = { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 };
const executorLimits = { timeoutMs: 10000, cpus: 1, memoryMiB: 256, maxInputBytes: 1048576, maxOutputBytes: 16384 };
const records = new Map<string, ExecutorRunRecord>();
const executor = new MicrosandboxExecutor({ image: pinned, record: async record => {
  records.set(record.id, record); await save('executor-runs.json', [...records.values()]);
} });
const executables = new ExecutableStore(join(root, 'executables'));
const source = await executables.put((await new ExecutableStore(join(proposalDirectory, 'executables')).get(proposal.candidate!.executor)).source);
assert.deepEqual(source.revision, proposal.candidate!.executor);
let requests = 0, preparations = 0;
const client = new TypeSafeClient({ timeout: 10000, retry: { maxRetries: 0 }, fetch: async (url, init) => {
  const id = ++requests; assert.equal(typeof init?.body, 'string');
  await save(`requests/${id}.json`, JSON.parse(init!.body as string));
  const response = await fetch(url, init); await save(`responses/${id}.json`, { status: response.status, body: await response.clone().json() }); return response;
} });
const builtin = { id: 'doom-jev-host', version: build.revision.version };
const models = (ledger: BudgetLedger) => new DoomLearningModels({ adapter: build.revision, builtinExecutor: builtin, profile: 'game-aware', executables, client,
  executable: artifact => new DoomPreparedModel(artifact, { store: executables, executor, ledger, client, limits: executorLimits,
    record: record => save(`preparations/${++preparations}.json`, record) }) });
const rebind = (original: typeof proposal.request.current) => {
  const { revision: _revision, ...fields } = original;
  return doomLearningArtifact({ ...fields, adapter: build.revision, executor: fields.model.id === 'typesafe' ? builtin : fields.executor });
};
const baseline = rebind(proposal.request.current), candidate = rebind(proposal.candidate!);
// The same explicit experiment profile exercises planning on both sides. The
// proposal was generated from a short action-mode trace; its bytes are unchanged.
const context: DoomEvaluationContext = { objective: proposal.request.objective, skills: [], overrides: {
  planningMode: 'plans', forkThreshold: .75, trialTicks: 210, decisionTicks: 35, breadth: 4, winnerDelaySeconds: 0,
} };
const contract: EvaluationContract<DoomVmScenario> = {
  id: 'doom-generated-planner-matched-v1', evaluator: build.revision,
  scenarios: [
    [{ ticks: 7, inputs: ['left'] }, { ticks: 21, inputs: ['forward'] }],
    [{ ticks: 21, inputs: ['right'] }, { ticks: 28, inputs: ['forward'] }],
    [{ ticks: 35, inputs: ['forward'] }, { ticks: 35, inputs: ['left'] }],
  ].map((setup, i) => ({ id: `start-${i}`, seed: 'doom-initial-rng', input: { setup, minimumSelectedTicks: 210 } })) as EvaluationContract<DoomVmScenario>['scenarios'],
  budget: { simulationUnit: 'doom-ticks', limits: { simulation: 4200, modelCalls: 64, executorCalls: 64 } }, maxRunMs: 180000,
  acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
};
const contextRevision = contentRevision('doom-user-context', context);
const evaluator = new DoomVmEvaluations({ directory: join(root, 'evaluations'), contract, models,
  runtime: microsandboxEvaluationVmPorts({ image: pinned, resources }), context: () => ({ revision: contextRevision, value: context }), measure: doomSurvivalProgress });
const request = { proposalId: randomUUID(), baseline, candidate, context: contextRevision, contract: evaluator.version };
await save('manifest.json', { proposalDirectory, original: { baseline: proposal.request.current, candidate: proposal.candidate },
  build, image: pinned, resources, executorLimits, context, contract, request,
  limitations: ['Three first-map starts withheld from source generation, not broad Doom proficiency.',
    'Identical maximum simulation/model/executor allowances and wall deadlines; actual usage can differ.',
    'Explicit common planning profile and current adapter build; not acceptance under the original diagnostic proposal contract.',
    'Jev is nondeterministic and uses an unpinned alias. No live activation or edits to generated source.'] });
const control = new AbortController(), abort = () => control.abort(new Error('Planner evaluation interrupted'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
console.log(JSON.stringify({ root, phase: 'evaluating', request: request.proposalId }));
try {
  const result = await evaluator.qualify(request, control.signal); await save('qualification.json', result);
  const report = JSON.parse(await readFile(join(root, 'evaluations', request.proposalId, 'comparison.json'), 'utf8'));
  await save('summary.json', { accepted: result.accepted, reason: result.reason, requests, preparations,
    meanGain: report.meanGain, runs: report.runs.map((run: any) => ({ role: run.role, scenario: run.scenarioId, status: run.status, ending: run.ending, metrics: run.metrics, error: run.error })) });
  console.log(JSON.stringify({ root, phase: 'compared', accepted: result.accepted, reason: result.reason, requests, preparations }));
} finally {
  try { await evaluator.recover(); }
  finally { for (const record of records.values()) if (record.phase !== 'released') await executor.recover(record); }
  const journal = decodeDoomEvaluationVms(JSON.parse(await readFile(join(root, 'evaluations', request.proposalId, 'resources.json'), 'utf8')));
  const snapshots = await Snapshot.list();
  for (const run of journal.runs) {
    for (const world of run.worlds) { assert.ok(world.released); await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError); }
    for (const point of run.checkpoints) {
      assert.ok(point.released); const [group, name] = point.reference.split(':');
      assert.ok(!snapshots.some(snapshot => snapshot.group === group && snapshot.name === name));
    }
  }
  for (const record of records.values()) { assert.equal(record.phase, 'released'); await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError); }
  await save('cleanup.json', { verified: true, worlds: journal.runs.reduce((sum, run) => sum + run.worlds.length, 0), executors: records.size });
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
