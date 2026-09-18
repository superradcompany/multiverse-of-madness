import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvaluationContract } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomVmEvaluations, type DoomVmScenario } from '../../apps/server/src/doom-vm-evaluations.ts';
import { microsandboxEvaluationVmPorts } from '../../apps/server/src/doom-evaluation-vm-provider.ts';
import { DoomLearningModels, doomLearningArtifact } from '../../apps/server/src/doom-learning-models.ts';
import { doomSurvivalProgress } from '../../apps/server/src/doom-revision-evaluation.ts';
import { Session } from '../../apps/server/src/session.ts';
import type { VmResources } from '../../packages/contracts/src/vm.ts';

if (!process.argv[2]) throw new Error('Pass the successful physical-ownership qualification directory');
const previous = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(previous, 'manifest.json'), 'utf8')) as { image: string; resources: VmResources; hashes: Record<string, string> };
for (const [file, hash] of Object.entries(manifest.hashes)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Source changed since ownership qualification: ${file}`);
const root = resolve('artifacts/doom-vm-evaluation', new Date().toISOString().replaceAll(':', '-'));
await mkdir(root, { recursive: true }); await cp(join(previous, 'source'), join(root, 'source'), { recursive: true });
await copyFile(import.meta.filename, join(root, 'qualification.ts.source'));
const write = <T>(file: string, value: T) => new JsonFileStore(join(root, file), input => input as T).save(value);
const build = { ...manifest.hashes, qualification: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex') };
const models = () => new DoomLearningModels({ adapter: contentRevision('doom-learning-adapter', build), builtinExecutor: contentRevision('doom-jev-host', build),
  profile: 'game-aware', executables: new ExecutableStore(join(root, 'executables')), executable: () => { throw new Error('This qualification uses real Jev, not executable revisions'); } });
const policy = new Session({ decide: async () => { throw new Error('Unused policy reader'); } }, { threshold: 1, horizon: 7, branches: 2, paceMs: 0 }).learningPolicy();
policy.planningMode = 'actions'; policy.decisionTicks = 7; policy.recovery.enabled = true;
const baseline = models().baseline(policy), { revision: _, ...fields } = baseline;
const candidate = doomLearningArtifact({ ...fields, prompts: { action: 'Use measured wall clearance and useful progress when comparing actions.' } });
const context = { objective: 'Survive and explore toward the exit.', skills: [], overrides: {} };
const contract: EvaluationContract<DoomVmScenario> = { id: 'real-vm-composition-v1', evaluator: contentRevision('doom-survival-progress-vm', build),
  scenarios: [{ id: 'first-map-start', seed: 'doom-initial-rng', input: { setup: [{ ticks: 7, inputs: ['left'] }] } }],
  budget: { simulationUnit: 'doom-ticks', limits: { simulation: 105, modelCalls: 2, executorCalls: 0 } }, maxRunMs: 120000,
  acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
const evaluator = new DoomVmEvaluations({ directory: join(root, 'evaluations'), contract, models, runtime: microsandboxEvaluationVmPorts(manifest),
  context: () => ({ revision: contentRevision('doom-user-context', context), value: context }), measure: doomSurvivalProgress });
const request = { proposalId: randomUUID(), baseline, candidate, context: contentRevision('doom-user-context', context), contract: evaluator.version };
const control = new AbortController(), abort = () => control.abort(new Error('Qualification interrupted'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
await write('manifest.json', { previous, build, image: manifest.image, resources: manifest.resources, contract, request,
  limitations: ['One short first-map paired scenario with a hand-authored prompt change, not evidence of general Doom improvement.',
    'Real Jev and real game VMs through the production evaluator composition. No revision activation or change to the live session.'] });
try {
  console.log(JSON.stringify({ root, phase: 'evaluating' }));
  const result = await evaluator.qualify(request, control.signal); await write('qualification.json', result);
  const report = JSON.parse(await readFile(join(root, 'evaluations', request.proposalId, 'comparison.json'), 'utf8'));
  assert.equal(report.runs.length, 2); assert.ok(report.runs.every((run: any) => run.status === 'complete'));
  assert.equal(report.runs.reduce((sum: number, run: any) => sum + run.evidence.decisions.length, 0), 4);
  const journal = JSON.parse(await readFile(join(root, 'evaluations', request.proposalId, 'resources.json'), 'utf8'));
  const { Sandbox, SandboxNotFoundError, Snapshot } = await import('microsandbox'); const snapshots = await Snapshot.list();
  for (const run of journal.runs) {
    assert.ok(run.closed && run.worlds.length >= 3 && run.worlds.every((world: any) => world.released));
    assert.ok(run.checkpoints.length && run.checkpoints.every((point: any) => point.released));
    for (const world of run.worlds) await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError);
    for (const point of run.checkpoints) { const [group, name] = point.reference.split(':'); assert.ok(!snapshots.some(snapshot => snapshot.group === group && snapshot.name === name)); }
  }
  await write('verification.json', { allOwnedVmsAbsent: true, allOwnedSnapshotsAbsent: true, completedRuns: 2, modelCalls: 4,
    chargedTicks: report.runs.reduce((sum: number, run: any) => sum + run.budget.entries.reduce((total: number, entry: any) => total + (entry.usage?.simulation ?? 0), 0), 0),
    accepted: result.accepted, reason: result.reason, worlds: journal.runs.reduce((sum: number, run: any) => sum + run.worlds.length, 0) });
  console.log(JSON.stringify({ root, phase: 'complete', accepted: result.accepted, reason: result.reason }));
} finally {
  await evaluator.recover(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
