import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import { DoomVmEvaluations } from '../apps/server/src/doom-vm-evaluations.ts';
import { DoomLearningModels, doomLearningArtifact } from '../apps/server/src/doom-learning-models.ts';
import { microsandboxEvaluationVmPorts } from '../apps/server/src/doom-evaluation-vm-provider.ts';
import { doomLearningDirectory } from '../apps/server/src/doom-learning-lineage.ts';
import { decodeDoomLearningManifest } from '../apps/server/src/doom-learning-manifest.ts';
import { doomSurvivalProgress } from '../apps/server/src/doom-revision-evaluation.ts';
import { SessionStore } from '../apps/server/src/persistence.ts';
import { Session } from '../apps/server/src/session.ts';
import { decision } from '../apps/server/test-support/fixture-runtime.ts';

// Real Doom forks with deterministic judgments. No paid model calls and no live-session mutation.
const data = resolve(process.argv[2] ?? '.data-demo-20260918');
const insufficientCoverage = process.argv.includes('--insufficient-coverage');
const saved = await new SessionStore(join(data, 'session.json')).load();
assert.ok(saved?.learning);
const lineage = await doomLearningDirectory(join(data, 'learning'), saved.learning.binding);
const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(lineage, 'manifest.json'), 'utf8')));
const directory = await mkdtemp(join(tmpdir(), 'mom-evaluation-allowance-'));
const client = { systemOne: async (body: { questions: Record<string, { criteria: Record<string, unknown> }> }) => ({
  model: 'deterministic-allowance-fixture', usage: { input_tokens: 1, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
    const ids = Object.keys(question.criteria), choice = ids.includes('wait') ? 'wait' : ids[0];
    return [key, { choice, confidence: 0.5, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
  })),
}) } as unknown as Pick<TypeSafeClient, 'systemOne'>;
const models = () => new DoomLearningModels({ adapter: { id: 'smoke', version: '1' }, builtinExecutor: { id: 'smoke-host', version: '1' },
  profile: 'game-aware', client, executables: new ExecutableStore(join(directory, 'sources')),
  executable: () => { throw new Error('No candidate source in lifecycle qualification'); } });
const policy = new Session({ decide: async () => decision }).learningPolicy();
Object.assign(policy, { trialTicks: 2100, decisionIntervalMode: 'trial', planningMode: 'actions', breadth: 4 });
policy.recovery.enabled = false;
const baseline = models().baseline(policy), { revision: _, ...fields } = baseline;
const candidate = doomLearningArtifact({ ...fields, prompts: { guide: 'Lifecycle qualification only.' } });
const context = { revision: { id: 'smoke', version: '1' }, value: { objective: 'Survive', skills: [], overrides: {}, maximumFutures: 4 } };
const evaluator = new DoomVmEvaluations({ directory, runtime: microsandboxEvaluationVmPorts(manifest), models,
  context: () => context, measure: doomSurvivalProgress,
  contract: { id: 'complete-futures-smoke', evaluator: { id: 'smoke', version: '1' },
    ...(insufficientCoverage ? {} : { allowance: 'complete-futures-v1' as const }),
    scenarios: [{ id: 'opening', seed: 'initial', input: { setup: [], minimumSelectedTicks: 210 } }],
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: insufficientCoverage ? 105 : 4200, modelCalls: 64, executorCalls: 64 } }, maxRunMs: 180000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } } });
const id = randomUUID();
console.log(JSON.stringify({ directory, proposalId: id }));
try {
  await evaluator.qualify({ proposalId: id, baseline, candidate, contract: evaluator.version, context: context.revision }, new AbortController().signal);
  const report = JSON.parse(await readFile(join(directory, id, 'comparison.json'), 'utf8'));
  assert.deepEqual(report.runs.map((run: { status: string }) => run.status), insufficientCoverage ? ['error', 'error'] : ['complete', 'complete']);
  assert.equal(report.contract.budget.limits.simulation, insufficientCoverage ? 105 : 8435);
  for (const run of report.runs) {
    assert.deepEqual(run.budget.spec, report.contract.budget);
    if (insufficientCoverage) {
      assert.match(run.error, /Insufficient selected gameplay/);
      assert.equal(run.metrics, undefined);
      assert.equal(run.evidence.session.stats.seconds - run.evidence.initialStats.seconds, 0);
      assert.ok(run.evidence.decisions.length > 0);
      assert.ok(run.evidence.session.worlds.some((world: { trial?: { elapsed: number } }) => (world.trial?.elapsed ?? 0) > 0));
      assert.equal(report.accepted, false);
    } else assert.ok(run.evidence.session.stats.seconds - run.evidence.initialStats.seconds >= 60);
    assert.equal(run.evidence.session.decision.futureLimit, 4);
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, runs: 2, futuresPerComparison: 4,
    mode: insufficientCoverage ? 'incomplete-evidence' : 'complete-futures', trialTicks: 2100,
    sharedSimulationAllowance: report.contract.budget.limits.simulation, committedAtLeast60Seconds: !insufficientCoverage,
    limitations: 'Deterministic judgments in real VMs qualify lifecycle and coverage, not Jev or strategy quality.' }, null, 2));
} finally {
  await evaluator.recover();
  const resources = JSON.parse(await readFile(join(directory, id, 'resources.json'), 'utf8'));
  const worlds = resources.runs.flatMap((run: { worlds: Array<{ id: string; released: boolean }> }) => run.worlds);
  for (const world of worlds) { assert.equal(world.released, true); await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError); }
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ allVmsAbsent: worlds.map((world: { id: string }) => world.id) }, null, 2));
}
console.log(JSON.stringify({ directory, passed: true }));
