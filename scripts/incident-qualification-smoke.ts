import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomLearningIncidents, decodeDoomIncidents } from '../examples/doom/server/src/doom-learning-incidents.ts';
import { DoomVmEvaluations } from '../examples/doom/server/src/doom-vm-evaluations.ts';
import { DoomLearningModels, doomLearningArtifact } from '../examples/doom/server/src/doom-learning-models.ts';
import { microsandboxEvaluationVmPorts } from '../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import { doomLearningDirectory } from '../examples/doom/server/src/doom-learning-lineage.ts';
import { decodeDoomLearningManifest } from '../examples/doom/server/src/doom-learning-manifest.ts';
import { doomSurvivalProgress } from '../examples/doom/server/src/doom-revision-evaluation.ts';
import { SessionStore } from '../examples/doom/server/src/persistence.ts';
import { Session, sessionContinuation } from '../examples/doom/server/src/session.ts';
import { Jev } from '../examples/doom/server/src/jev.ts';

// Real VM capture/restore and evaluation; deterministic model responses isolate lifecycle verification.
const data = resolve(process.argv[2]!);
const saved = await new SessionStore(join(data, 'session.json')).load(); assert.ok(saved?.learning);
const lineage = await doomLearningDirectory(join(data, 'learning'), saved.learning.binding);
const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(lineage, 'manifest.json'), 'utf8')));
const directory = await mkdtemp(join(tmpdir(), 'mom-incident-qualification-'));
console.log('Evidence directory:', directory);
const ports = microsandboxEvaluationVmPorts(manifest);
const session = new Session(new Jev('game-aware'), { threshold: 0, horizon: 35, branches: 2, paceMs: 0 });
session.setPlanningMode('actions'); session.setDecisionInterval(35);
session.setCheckpointAdapter({ capture: ports.capture, restore: ports.restore, remove: async reference => { await ports.collect([{ reference }]); } });
const owner = await DoomLearningIncidents.open({ store: new JsonFileStore(join(directory, 'incidents.json'), decodeDoomIncidents),
  capture: (reference, signal) => session.captureLearningIncident(reference, signal), runtime: ports });
const client = { systemOne: async (body: { questions: Record<string, { criteria: Record<string, unknown> }> }) => ({
  model: 'deterministic-lifecycle-fixture', usage: { input_tokens: 1, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
    const ids = Object.keys(question.criteria), choice = ids.includes('wait') ? 'wait' : ids[0];
    return [key, { choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
  })),
}) } as unknown as Pick<TypeSafeClient, 'systemOne'>;
const models = () => new DoomLearningModels({ adapter: { id: 'smoke', version: '1' }, builtinExecutor: { id: 'smoke-host', version: '1' },
  profile: 'game-aware', client, executables: new ExecutableStore(join(directory, 'source')), executable: () => { throw new Error('No generated executor in lifecycle smoke'); } });
const baseline = models().baseline(session.learningPolicy());
const { revision: _, ...fields } = baseline;
const candidate = doomLearningArtifact({ ...fields, prompts: { action: 'Wait for this lifecycle verification.' } });
const context = { revision: { id: 'smoke-guide', version: '1' }, value: { objective: 'Survive', skills: [], overrides: {} } };
const evaluator = new DoomVmEvaluations({ directory: join(directory, 'evaluations'), runtime: ports, models, context: () => context, measure: doomSurvivalProgress,
  contract: { id: 'incident-lifecycle-smoke', evaluator: { id: 'doom-survival-progress', version: '1' },
    scenarios: [{ id: 'opening', seed: '1', input: { setup: [], minimumSelectedTicks: 210 } }],
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: 315, modelCalls: 8 } }, maxRunMs: 60000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } } });
try {
  await session.initialize(await ports.create('mom-incident-smoke-' + randomUUID().slice(0, 8), randomUUID(), 'source'));
  const id = randomUUID(), incident = await owner.capture(id, new AbortController().signal);
  const result = await evaluator.qualify({ proposalId: id, baseline, candidate, context: context.revision, contract: evaluator.version }, new AbortController().signal, incident.snapshot, sessionContinuation(incident.evidence));
  const report = JSON.parse(await readFile(join(directory, 'evaluations', id, 'comparison.json'), 'utf8'));
  assert.equal(report.runs.length, 2);
  assert.ok(report.runs.every((run: { status: string; error?: string }) => run.status === 'complete'), JSON.stringify(report.runs.map((run: { status: string; error?: string }) => ({ status: run.status, error: run.error }))));
  const state = incident.evidence.worlds.find(world => world.view.id === incident.evidence.view.mainId)!.view.state;
  for (const run of report.runs.filter((run: { scenarioId: string }) => run.scenarioId === 'saved-stuck-position')) assert.deepEqual(run.evidence.initial, state);
  assert.equal(result.accepted, false, 'an unchanged wait policy cannot qualify as an improvement');
  assert.equal(await ports.snapshotIdentity(incident.snapshot.reference), incident.snapshot.identity);
  await owner.collect(new Set()); assert.equal(await ports.snapshotIdentity(incident.snapshot.reference), undefined);
  console.log(JSON.stringify({ passed: true, realVmRuns: 2, unnecessaryOpeningRunsSkipped: true, matchedSavedPosition: true, unchangedPolicyRejected: true, checkpointCollected: true }));
} finally {
  await evaluator.recover(); await session.close(); await owner.collect(new Set());
}
