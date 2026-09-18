import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomEvaluationVms, decodeDoomEvaluationVms, doomIncidentCheckpoint } from '../apps/server/src/doom-evaluation-vms.ts';
import { microsandboxEvaluationVmPorts } from '../apps/server/src/doom-evaluation-vm-provider.ts';
import { doomLearningDirectory } from '../apps/server/src/doom-learning-lineage.ts';
import { decodeDoomLearningManifest } from '../apps/server/src/doom-learning-manifest.ts';
import { SessionStore } from '../apps/server/src/persistence.ts';
import { candidatePlans, planInputs, startPlan } from '../apps/server/src/doom-plans.ts';
import { geometryFor } from '../apps/server/src/doom-geometry.ts';
import { navigateDoomInputs, planNavigationMemory, type NavigationMemory } from '../apps/server/src/doom-navigation.ts';
import { Session } from '../apps/server/src/session.ts';
import { actions, type ActionId } from '../apps/server/src/jev.ts';
import { doomInputs } from '../apps/server/src/doom-controls.ts';

// Mechanical diagnostic, not an AI/evaluation score: execute the same observed
// plan from one retained checkpoint with and without collision-recovery steering.
// The live session is never controlled here. Keep the checkpoint until this ends.
const [input, checkpointId, family = 'interaction'] = process.argv.slice(2);
if (!input || !checkpointId) throw new Error('Usage: tsx scripts/diagnose-plan.ts DATA_DIRECTORY CHECKPOINT_ID [PLAN_FAMILY]');
const data = resolve(input), saved = await new SessionStore(join(data, 'session.json')).load();
assert.ok(saved?.learning);
const point = saved.recovery?.points.find(point => point.id === checkpointId); assert.ok(point, 'Retained checkpoint required');
const lineage = await doomLearningDirectory(join(data, 'learning'), saved.learning.binding);
const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(lineage, 'manifest.json'), 'utf8')));
const ports = microsandboxEvaluationVmPorts(manifest), identity = await ports.snapshotIdentity(point.reference); assert.ok(identity);
const initial = point.world.state, map = await geometryFor(initial, true, true);
const candidates = candidatePlans(initial, map, point.stats.visited, point.pickups);
const plan = candidates.find(plan => plan.family === family || plan.id === family);
assert.ok(plan, `No ${family} plan at checkpoint; available: ${candidates.map(plan => plan.id).join(', ')}`);
const incident = doomIncidentCheckpoint(point.reference, identity, initial);
const directory = await mkdtemp(join(tmpdir(), 'mom-plan-diagnostic-'));
await writeFile(join(directory, 'input.json'), JSON.stringify({ checkpointId, initial, plan }, null, 2));
console.log('Diagnostic directory:', directory);
const owner = await DoomEvaluationVms.open(new JsonFileStore(join(directory, 'resources.json'), decodeDoomEvaluationVms), ports);
const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 1680 } });
const position = (state: typeof initial) => ({ tick: state.tick, x: state.x, y: state.y, z: state.z, angle: state.angle, health: state.health, items: state.items, keys: state.keys });
try {
  for (const mode of ['collision-recovery', 'plan-intent', 'step-scoped-recovery'] as const) {
    const world = await owner.create(mode, ledger, AbortSignal.timeout(120_000), [], incident);
    let state = await world.state(); assert.deepEqual(state, initial);
    const run = startPlan(plan, state, 420), history: typeof initial[] = [];
    let memory: NavigationMemory = {};
    const trace: unknown[] = [];
    for (let tick = 0; tick < 420 && run.status === 'running'; tick++) {
      const previousStep = run.step;
      const requested = planInputs(run, state, history, map);
      if (mode === 'step-scoped-recovery') memory = planNavigationMemory(memory, run, previousStep) ?? {};
      if (run.status !== 'running') break;
      let inputs = requested;
      if (mode !== 'plan-intent' && memory.escape) inputs = ['forward'];
      if (!inputs.every(input => input === 'left' || input === 'right')) inputs = mode !== 'plan-intent'
        ? navigateDoomInputs(state, inputs, map, memory) : doomInputs(state, inputs, map);
      trace.push({ ...position(state), step: run.step, requested, inputs, navigation: structuredClone(memory) });
      history.push(state); if (history.length > 12) history.shift();
      state = await world.step({ ticks: 1, inputs });
    }
    planInputs(run, state, history, map);
    await writeFile(join(directory, mode + '.png'), await world.frame());
    const result = { mode, status: run.status, reason: run.reason, step: run.step, start: position(initial), end: position(state),
      elapsedTicks: state.tick - initial.tick, progressEvents: state.progressEvents, plan, trace };
    await writeFile(join(directory, mode + '.json'), JSON.stringify(result));
    console.log(JSON.stringify({ ...result, plan: plan.id, trace: trace.length }));
    await owner.cleanup(mode);
  }
  // Verify the corrected behavior through the production Session loop too.
  const world = await owner.create('session-controller', ledger, AbortSignal.timeout(120_000), [], incident);
  const session = new Session({ decide: async () => ({ action: 'advance', confidence: 1, priority: 'exploration', latencyMs: 0, model: 'mechanical-plan-fixture',
    probabilities: Object.fromEntries(Object.keys(actions).map(id => [id, Number(id === 'advance')])) as Record<ActionId, number>,
    plans: { selected: plan.id, candidates: [{ ...plan, probability: 1 }] } }) }, { threshold: 0, branches: 2, horizon: 420, paceMs: 0 });
  session.setDecisionInterval(420);
  session.setControls(async (state, inputs, memory) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), memory));
  await session.initialize(world);
  let paused: Promise<void> | undefined;
  session.setRecorder(async view => {
    if (!paused && (view.plan?.status !== 'running' || view.state.tick >= initial.tick + 420
      || view.state.progressEvents?.some(event => event.kind === 'switch' && event.tick > initial.tick))) paused = session.pause();
  });
  try {
    session.resume(); await session.idle(); await paused;
    const view = session.snapshot(); assert.equal(view.error, undefined);
    const end = view.worlds.find(world => world.id === view.mainId)!;
    const result = { mode: 'session-controller', start: position(initial), end: position(end.state), plan: end.plan,
      progressEvents: end.state.progressEvents, elapsedTicks: end.state.tick - initial.tick };
    await writeFile(join(directory, 'session-controller.json'), JSON.stringify(result));
    await writeFile(join(directory, 'session-controller.png'), await world.frame());
    console.log(JSON.stringify(result));
  } finally { await session.close(); await owner.cleanup('session-controller'); }
  assert.equal(await ports.snapshotIdentity(point.reference), identity, 'Diagnostic must retain its borrowed checkpoint');
} finally { await owner.recover(); }
