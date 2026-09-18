import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { Session } from '../apps/server/src/session.ts';
import { checkpoints } from '../apps/server/src/checkpoints.ts';
import { createWorld } from '../apps/server/src/runtime.ts';
import { decision } from '../apps/server/test-support/fixture-runtime.ts';

// Actual Doom VMs/forks/checkpoint capture. Scripted decisions qualify lifecycle,
// not Jev behavior or gameplay strength. Never opens the user's live session.
const directory = await mkdtemp(join(tmpdir(), 'mom-paused-incident-'));
const reference = `mom-checkpoint-${randomUUID()}:recovery`;
const control = new AbortController();
const session = new Session({ decide: async () => ({ ...decision, confidence: 1 }) },
  { threshold: 0, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
let initialized = false, timer: ReturnType<typeof setTimeout> | undefined;
let source: Awaited<ReturnType<typeof createWorld>> | undefined;
const ids = new Set<string>();
try {
  source = await createWorld(`mom-paused-incident-${randomUUID()}`); ids.add(source.id);
  await session.initialize(source); initialized = true;
  session.setPlanningMode('actions'); session.setCheckpointAdapter(checkpoints);
  session.setPersistence(saved => writeFile(join(directory, 'session.json'), JSON.stringify(saved)));
  session.step(); await session.idle(); assert.equal(session.snapshot().error, undefined);
  const compared = session.snapshot();
  assert.equal(compared.worlds.filter(world => world.role === 'experiment').length, 2);
  for (const world of compared.worlds) ids.add(world.id);
  const pending = session.captureLearningIncident(reference, control.signal); void pending.catch(() => {});
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Paused checkpoint did not complete')), 30000); });
  session.step(); await session.idle();
  const captured = await Promise.race([pending, timeout]);
  assert.equal(captured.view.running, false); assert.equal(session.snapshot().error, undefined);
  const main = captured.worlds.find(world => world.view.id === captured.view.mainId)!;
  assert.equal(main.view.state.tick, 42);
  const restored = await checkpoints.restore(reference, `mom-paused-incident-restored-${randomUUID()}`); ids.add(restored.id);
  try { assert.deepEqual(await restored.state(), main.view.state); }
  finally { await restored.destroy(); }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, selectedTick: main.view.state.tick,
    captureWhilePaused: true, extraGameplayNeeded: false, exactRestore: true, realVmCount: ids.size, vmIds: [...ids] }, null, 2));
  console.log(JSON.stringify({ directory, capturedTick: main.view.state.tick, exactRestore: true }));
} finally {
  clearTimeout(timer); control.abort();
  if (initialized) await session.close(); else await source?.destroy();
  const removed = await checkpoints.collect!([reference]); assert.deepEqual(removed, [reference]);
  for (const id of ids) await assert.rejects(Sandbox.get(id), SandboxNotFoundError);
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ allVmsAbsent: [...ids], checkpointRemoved: reference }, null, 2));
}
