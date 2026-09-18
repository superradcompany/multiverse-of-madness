import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { BudgetLedger, RevisionController, type EvaluationContract, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { decodeDoomProposal } from '../../apps/server/src/doom-supervisor-proposal.ts';
import { decodeDoomSupervisor } from '../../apps/server/src/doom-supervisor.ts';
import { DoomLearningModels } from '../../apps/server/src/doom-learning-models.ts';
import { DoomExecutableModel } from '../../apps/server/src/doom-executor-model.ts';
import { qualifyDoomRevision, doomSurvivalProgress, type DoomEvaluationContext, type DoomEvaluationOptions } from '../../apps/server/src/doom-revision-evaluation.ts';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import type { DoomPolicy } from '../../apps/server/src/doom-policy.ts';
import type { WorldRuntime } from '../../apps/server/src/runtime.ts';
import type { Step } from '../../packages/contracts/src/game.ts';
import { EvaluationWorld } from './doom-runtime.ts';

if (!process.argv[2]) throw new Error('Usage: doom-revision.ts <proposal.json>');
const inputPath = resolve(process.argv[2]), inputRoot = dirname(inputPath);
const proposal = decodeDoomProposal(JSON.parse(await readFile(inputPath, 'utf8')));
assert.equal(proposal.status, 'submitted'); assert.ok(proposal.candidate);
const original = decodeDoomSupervisor(JSON.parse(await readFile(join(inputRoot, 'supervisor.json'), 'utf8')));
const builtin = original.journal.artifacts.find(artifact => artifact.model.id === 'typesafe');
if (!builtin) throw new Error('This evaluation host needs the original built-in Jev manifest');
const baseline = proposal.request.current, candidate = proposal.candidate;
const root = resolve('artifacts/doom-revision-evaluation', new Date().toISOString().replaceAll(':', '-'));
await mkdir(root, { recursive: true });
const write = <T>(file: string, value: T) => new JsonFileStore(join(root, file), value => value as T).save(value);
const sourceRoots = ['apps/server/src', 'packages/contracts/src', 'packages/game-bridge/src', 'packages/executor-microsandbox/src', 'harness/src', 'scripts/evaluation'];
const files = ['assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'package-lock.json', ...(
  await Promise.all(sourceRoots.map(async directory => (await readdir(directory, { recursive: true }))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => join(directory, file))))).flat()].sort();
const builds = Object.fromEntries(await Promise.all(files.map(async file => {
  const bytes = await readFile(file);
  if (!file.startsWith('assets/')) { const target = join(root, 'source', file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  return [file, createHash('sha256').update(bytes).digest('hex')];
})));
const setups: Step[][] = [
  [{ ticks: 7, inputs: ['left'] }, { ticks: 21, inputs: ['forward'] }],
  [{ ticks: 21, inputs: ['right'] }, { ticks: 28, inputs: ['forward'] }],
  [{ ticks: 35, inputs: ['forward'] }, { ticks: 35, inputs: ['left'] }],
];
const contract: EvaluationContract<{ setup: Step[] }> = {
  id: 'doom-proposal-survival-progress-v1', evaluator: contentRevision('doom-independent-evaluator', builds),
  scenarios: setups.map((setup, index) => ({ id: 'private-start-' + index, seed: 'doom-initial-rng', input: { setup } })),
  budget: { simulationUnit: 'doom-ticks', limits: { simulation: 1050, modelCalls: 12, executorCalls: 12 } }, maxRunMs: 180000,
  acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
};
const observations = proposal.request.evidence.observations;
const context: DoomEvaluationContext = { objective: proposal.request.objective, overrides: observations.userOverrides as DoomEvaluationContext['overrides'],
  skills: ((observations.userSkills ?? []) as Array<Omit<DoomEvaluationContext['skills'][number], 'enabled'>>).map(skill => ({ ...skill, enabled: true })) };
const executables = new ExecutableStore(join(inputRoot, 'executables'));
const executions = new Map<string, ExecutorRunRecord>();
const executor = new MicrosandboxExecutor({ image: 'docker.io/library/node@sha256:c90fbae51ca047f2fda9ea92fb85eb936c08e6df18df7462bb782bad7c6afa3d',
  record: async record => { executions.set(record.id, record); await write('executor-runs.json', [...executions.values()]); } });
const limits = { timeoutMs: 10000, cpus: 1, memoryMiB: 256, maxInputBytes: 131072, maxOutputBytes: 16384 };
const worlds = new Map<string, EvaluationWorld[]>();
const runFile = (id: string) => contentRevision('evaluation-run', id).version.slice(7);
const options: DoomEvaluationOptions<{ setup: Step[] }> = {
  contract, context,
  models: ledger => new DoomLearningModels({ adapter: baseline.adapter, builtinExecutor: builtin.executor, profile: 'game-aware', executables,
    executable: (artifact: LearningRevision<DoomPolicy>) => new DoomExecutableModel(artifact, { store: executables, executor, ledger, limits,
      record: result => write('executor-decisions/' + randomUUID() + '.json', result) }) }),
  create: async (id, scenario, ledger, signal) => {
    const owned: EvaluationWorld[] = []; worlds.set(id, owned);
    const own = (world: EvaluationWorld): WorldRuntime => {
      owned.push(world);
      return { id: world.id, identity: world.identity, state: () => world.state(), frame: () => world.frame(), step: command => world.step(command),
        destroy: () => world.destroy(), branch: async ids => (await world.branch(ids)).map(own) };
    };
    const world = await EvaluationWorld.create(id, ledger, signal); const tracked = own(world);
    for (const step of scenario.input.setup) await world.step(step, 'scenario-setup');
    return tracked;
  },
  cleanup: async id => { for (const world of worlds.get(id) ?? []) await world.destroy(); },
  measure: doomSurvivalProgress,
  persistSession: (id, saved) => write('runs/' + runFile(id) + '/session.json', saved),
  persistBudget: (id, saved) => write('runs/' + runFile(id) + '/budget.json', saved),
  persistRun: run => write('runs/' + runFile(run.id) + '/result.json', run),
  persistComparison: report => write('comparison.json', report),
};
await write('manifest.json', { inputPath, proposal: proposal.id, baseline, candidate, context, contract, builds, node: process.version,
  limitations: ['Real local Doom WASM; game forks use metered replay, not VM snapshots.', 'Three short starts in the first map, not broad Doom competence or a level-completion benchmark.',
    'Starts were not sent to the outer proposal model. The suite was fixed before evaluation, after proposal generation.', 'Model aliases may change and decisions are nondeterministic; actual serving models and usage are recorded.',
    'A separate evaluation-only controller is required because the proposal qualification used an acceptance-not-run placeholder. Neither original proposal journal nor active game is modified.',
    'Checkpoint recovery policies require a VM-backed evaluator; this local evaluator refuses them.'] });
const control = new AbortController(), abort = () => control.abort(new Error('Evaluation interrupted'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
try {
  const controller = await RevisionController.create(baseline, { contract: contentRevision('doom-evaluation-contract', contract),
    capabilities: ['policy', 'prompts', 'skills', 'executor', 'model'], maxLifetimeMs: 3600000 }, {
    context: () => contentRevision('doom-evaluation-context', context),
    boundary: async () => { throw new Error('This experiment does not activate revisions'); },
    compatible: async () => { throw new Error('This experiment does not activate revisions'); },
    verify: artifact => options.models(new BudgetLedger(contract.budget)).verify(artifact),
    qualify: (request, signal) => qualifyDoomRevision(request, options, signal),
    persist: saved => write('evaluation-controller.json', saved),
  });
  await controller.submit({ id: proposal.id, candidate, reason: proposal.reason!, expiresAt: Date.now() + 3600000 });
  console.log(JSON.stringify({ root, phase: 'evaluating', scenarios: setups.length, perRun: contract.budget }));
  const result = await controller.evaluate(proposal.id, control.signal);
  assert.equal(controller.active.epoch, 0);
  await write('result.json', result);
  console.log(JSON.stringify({ root, status: result.status, accepted: result.qualification?.accepted, reason: result.qualification?.reason, activeEpoch: controller.active.epoch }));
} finally {
  for (const owned of worlds.values()) for (const world of owned) await world.destroy();
  for (const record of executions.values()) if (record.phase !== 'released') await executor.recover(record);
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
