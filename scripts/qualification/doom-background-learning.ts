import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomLearningService } from '../../examples/doom/server/src/doom-learning-service.ts';
import { readDoomLearningBuild } from '../../examples/doom/server/src/doom-learning-build.ts';
import { DoomEvaluationVms, decodeDoomEvaluationVms } from '../../examples/doom/server/src/doom-evaluation-vms.ts';
import { microsandboxEvaluationVmPorts } from '../../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import { observeDoomLearning } from '../../examples/doom/server/src/doom-autonomous-learning.ts';
import { Session } from '../../examples/doom/server/src/session.ts';
import { SessionStore } from '../../examples/doom/server/src/persistence.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../../examples/doom/server/src/doom-navigation.ts';
import { CodexCliSupervisor } from '../../packages/supervisor-codex/src/provider.ts';
import type { DoomPolicy } from '../../examples/doom/server/src/doom-policy.ts';
import type { DoomProposalEvidence } from '../../examples/doom/server/src/doom-supervisor-proposal.ts';

// Fault-inject a real idle interval, then use the production observer, Codex, Jev,
// evaluator and activation path. No simulated observation or forced acceptance.
const root = resolve('artifacts/doom-background-learning', new Date().toISOString().replaceAll(':', '-'));
await mkdir(join(root, 'jev'), { recursive: true });
await copyFile(import.meta.filename, join(root, 'qualification.ts.source'));
const save = <T>(name: string, value: T) => new JsonFileStore(join(root, name), value => value as T).save(value);
const control = new AbortController(), abort = () => control.abort(new Error('Qualification interrupted'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
const { Image, Sandbox, Snapshot } = await import('microsandbox');
const base = await Image.get('docker.io/library/node:24-alpine'); assert.ok(base.manifestDigest);
const image = `docker.io/library/node@${base.manifestDigest}`;
const resources = { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 };
const build = await readDoomLearningBuild();
const owner = await DoomEvaluationVms.open(new JsonFileStore(join(root, 'resources.json'), decodeDoomEvaluationVms),
  microsandboxEvaluationVmPorts({ image, resources }));
const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 21000 } }, value => save('game-budget.json', value));
const client = new TypeSafeClient({ timeout: 10000, retry: { maxRetries: 0 } });
let modelCalls = 0, providerCalls = 0;
const modelClient: Pick<TypeSafeClient, 'systemOne'> = { systemOne: (request, options) => {
  const id = ++modelCalls;
  writeFileSync(join(root, 'jev', `${id}-request.json`), JSON.stringify(request));
  return client.systemOne(request, options).map(response => {
    writeFileSync(join(root, 'jev', `${id}-response.json`), JSON.stringify(response)); return response;
  });
} };
const session = new Session({ decide: async () => { throw new Error('Only the bound learning model may decide'); } },
  { threshold: 0, horizon: 70, branches: 2, paceMs: 20, frameTicks: 35 });
const store = new SessionStore(join(root, 'session.json'));
session.setPersistence(value => store.save(value));
session.setCheckpointAdapter(owner.checkpoints('background-main'));
session.setControls(async (state, inputs, navigation, policy) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation, policy));
let service: DoomLearningService | undefined;
let verification: Record<string, unknown> | undefined;
try {
  console.log(JSON.stringify({ root, phase: 'creating-isolated-game' }));
  await session.initialize(await owner.create('background-main', ledger, control.signal));
  await session.takeover(session.snapshot().mainId);
  for (let i = 0; i < 16; i++) { control.signal.throwIfAborted(); await session.input(session.snapshot().mainId, []); }
  session.release(session.snapshot().mainId);
  const training = session.snapshot();
  assert.ok(observeDoomLearning(training), 'Controlled idle interval must produce genuine stall evidence');
  await save('training.json', session.checkpoint());
  service = await DoomLearningService.open({ directory: join(root, 'learning'), profile: 'game-aware', build, image, modelClient,
    proposalProvider: async record => {
      const codex = await CodexCliSupervisor.open<DoomPolicy, DoomProposalEvidence>({ record });
      return { version: codex.version, propose: (...args) => { providerCalls++; return codex.propose(...args); } };
    } });
  await service.attach(session);
  await save('manifest.json', { build, image, resources, setup: '16 seconds of real idle inputs under human control, released to AI before learning',
    limitations: ['Lifecycle qualification with an injected stall, not a natural-stall or general game-strength benchmark.',
      'Uses the production independent six-run acceptance contract. Rejection is a valid result; no forced acceptance.',
      'One isolated game and its evaluation VMs; the existing live session is never attached or modified.'] });
  await service.enable();
  const admissionDeadline = Date.now() + 10000;
  while (!service.view().automation?.cycle) {
    control.signal.throwIfAborted(); assert.ok(Date.now() < admissionDeadline, 'Observer did not admit an automatic cycle');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proposalId = service.view().automation!.cycle!.proposalId;
  session.resume();
  const progress: Array<{ phase: string; seconds: number; at: number }> = [];
  let phase = '', lastLog = 0;
  while (!service.view().automation?.lastOutcome) {
    control.signal.throwIfAborted();
    const view = service.view(), game = session.snapshot();
    assert.equal(game.error, undefined);
    const job = view.jobs.find(job => ['queued', 'running', 'cancelling'].includes(job.status));
    const current = job?.kind ?? view.proposals.find(item => item.id === proposalId)?.status ?? 'admitted';
    if (current !== phase || Date.now() - lastLog > 10000) {
      phase = current; lastLog = Date.now();
      const entry = { phase, seconds: game.stats!.seconds, at: lastLog }; progress.push(entry);
      await save('progress.json', progress);
      console.log(JSON.stringify({ root, ...entry, mainRunning: game.running, providerCalls, modelCalls }));
    }
    assert.equal(view.automation?.error, undefined);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await session.pause();
  await service.setAutomation(false, 'codex');
  const learning = service.view(), game = session.snapshot();
  await save('learning-result.json', learning); await save('game-result.json', session.checkpoint());
  assert.equal(providerCalls, 1);
  assert.ok(game.stats!.seconds > training.stats!.seconds, 'Gameplay must advance during background work');
  assert.ok(progress.some(entry => entry.phase === 'evaluate'), 'Independent evaluation must run automatically');
  assert.ok(['activated', 'rejected'].includes(learning.automation!.lastOutcome!.status), JSON.stringify(learning.automation!.lastOutcome));
  const proposal = JSON.parse(await readFile(join(root, 'learning', 'proposals', proposalId + '.json'), 'utf8'));
  assert.equal(proposal.request.evidence.requestedKind, 'guidance');
  assert.equal(proposal.request.evidence.preparationExample, undefined);
  const preview = await service.evaluationView(proposalId);
  await save('evaluation-preview.json', preview);
  assert.equal(preview.finished, 6); assert.equal(preview.active, false);
  verification = { status: 'passed', providerCalls, modelCalls, outcome: learning.automation!.lastOutcome,
    mainSecondsBefore: training.stats!.seconds, mainSecondsAfter: game.stats!.seconds, completedEvaluationRuns: preview.finished };
} catch (error) {
  await save('failure.json', { error: error instanceof Error ? error.stack : String(error), learning: service?.view(), game: session.snapshot() });
  throw error;
} finally {
  try { await session.pause(); await service?.close(); } finally {
    await owner.recover(); await ledger.join(); await store.flush();
    const journal = owner.snapshot();
    const inventory = await Sandbox.listWith(builder => builder.label('evaluation-owner', journal.owner).limit(100));
    assert.equal(inventory.sandboxes.length, 0); assert.equal(inventory.nextCursor, undefined);
    const snapshots = await Snapshot.list();
    for (const run of journal.runs) for (const point of run.checkpoints) {
      const [group, name] = point.reference.split(':');
      assert.ok(!snapshots.some(snapshot => snapshot.group === group && snapshot.name === name));
    }
    if (verification) {
      await save('verification.json', { ...verification, mainOwnedVmsAndSnapshotsReleased: true });
      console.log(JSON.stringify({ root, ...verification, mainOwnedVmsAndSnapshotsReleased: true }));
    }
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
