import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomEvaluationVms, decodeDoomEvaluationVms, doomIncidentCheckpoint } from '../examples/doom/server/src/doom-evaluation-vms.ts';
import { microsandboxEvaluationVmPorts } from '../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import { doomLearningDirectory } from '../examples/doom/server/src/doom-learning-lineage.ts';
import { decodeDoomLearningManifest } from '../examples/doom/server/src/doom-learning-manifest.ts';
import { SessionStore } from '../examples/doom/server/src/persistence.ts';

const input = process.argv[2];
if (!input) throw new Error('Pass a session data directory containing a retained execution checkpoint');
const data = resolve(input), saved = await new SessionStore(join(data, 'session.json')).load();
assert.ok(saved?.learning);
const point = saved.recovery?.points.at(-1); assert.ok(point);
const lineage = await doomLearningDirectory(join(data, 'learning'), saved.learning.binding);
const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(lineage, 'manifest.json'), 'utf8')));
const ports = microsandboxEvaluationVmPorts(manifest), identity = await ports.snapshotIdentity(point.reference);
assert.ok(identity);
const incident = doomIncidentCheckpoint(point.reference, identity, point.world.state);
const directory = await mkdtemp(join(tmpdir(), 'mom-incident-smoke-'));
console.log('Resource journal:', directory);
const owner = await DoomEvaluationVms.open(new JsonFileStore(join(directory, 'resources.json'), decodeDoomEvaluationVms), ports);
const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 14 } });
try {
  for (const role of ['baseline', 'candidate']) {
    const world = await owner.create(role, ledger, new AbortController().signal, [], incident);
    assert.deepEqual(await world.state(), point.world.state);
    const [future] = await world.branch([world.id + '-future']); assert.ok(future);
    assert.deepEqual(await future.state(), point.world.state);
    await future.step({ ticks: 7, inputs: ['left'] });
    await owner.cleanup(role);
    await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError);
    await assert.rejects(Sandbox.get(future.id), SandboxNotFoundError);
    assert.equal(await ports.snapshotIdentity(point.reference), identity);
  }
  assert.equal(ledger.used('simulation'), 14);
  console.log(JSON.stringify({ passed: true, restoredTick: point.world.state.tick, pairedRuns: 2,
    gameVmsReleased: 4, meteredNewTicks: 14, borrowedCheckpointRetained: true }));
} finally { await owner.recover(); }
