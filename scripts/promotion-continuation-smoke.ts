import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { WorldLifecycle, type WorldMetadata } from '@multiverse/gameplay-harness';
import { createWorld, type WorldRuntime } from '../apps/server/src/runtime.ts';

type World = { meta: WorldMetadata; runtime?: WorldRuntime };
const directory = await mkdtemp(join(tmpdir(), 'mom-promotion-smoke-'));
const runtimes: WorldRuntime[] = [];
const lifecycle: WorldLifecycle<World, WorldRuntime> = new WorldLifecycle<World, WorldRuntime>({
  metadata: world => world.meta,
  persist: async () => writeFile(join(directory, 'journal.json'), JSON.stringify({
    mainId: lifecycle.mainId, cleanup: lifecycle.cleanup,
    worlds: [...lifecycle.worlds.values()].map(world => ({ ...world.meta, identity: world.runtime?.identity })),
  })),
});
let release!: () => void;
const held = new Promise<void>(resolve => { release = resolve; });
try {
  const source = await createWorld(`mom-promotion-smoke-${randomUUID()}`); runtimes.push(source);
  const children = await source.branch([`${source.id}-a`, `${source.id}-b`]); runtimes.push(...children);
  const winner = children[0]!;
  const before = await winner.state();
  for (const runtime of runtimes) lifecycle.register({ runtime, meta: {
    id: runtime.id, role: runtime === source ? 'main' : 'experiment', status: 'paused', controller: 'ai',
  } });
  lifecycle.mainId = source.id;
  const destroy = source.destroy.bind(source);
  let deleteFinished = false;
  // Hold only this smoke's source deletion to deterministically exercise overlap.
  source.destroy = async () => { await held; await destroy(); deleteFinished = true; };
  await lifecycle.promote(winner.id, { cleanup: 'background' });
  const after = await winner.step({ ticks: 7, inputs: ['left'] });
  assert.equal(after.tick, before.tick + 7);
  assert.equal(deleteFinished, false);
  assert.equal(lifecycle.world(winner.id).runtime, winner);
  assert.ok(lifecycle.cleanup.some(entry => entry.identity === source.identity));
  release(); await lifecycle.join();
  assert.deepEqual(lifecycle.cleanup, []);
  for (const runtime of runtimes.filter(runtime => runtime !== winner)) await assert.rejects(Sandbox.get(runtime.id), SandboxNotFoundError);
  assert.equal((await Sandbox.get(winner.id)).id, winner.identity);
  console.log(JSON.stringify({ passed: true, journal: directory, realWinnerTicksDuringHeldCleanup: 7,
    losingVmsReleased: 2, winnerIdentityPreserved: true }));
} finally {
  release();
  const settled = await Promise.allSettled([lifecycle.join()]);
  const results = await Promise.allSettled(runtimes.map(async runtime => {
    try { const existing = await Sandbox.get(runtime.id); assert.equal(existing.id, runtime.identity); await runtime.destroy(); }
    catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error; }
  }));
  const failed = [...settled, ...results].filter(result => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Smoke runtime cleanup failed');
}
