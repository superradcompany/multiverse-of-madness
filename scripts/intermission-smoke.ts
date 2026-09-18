import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { reconnectWorld } from '../examples/doom/server/src/runtime.ts';
import { Session } from '../examples/doom/server/src/session.ts';

// Run only while the source's host is stopped/paused. Fork the exact real
// intermission without advancing or destroying the retained source world.
const [sourceId, sourceIdentity] = process.argv.slice(2);
if (!sourceId || !sourceIdentity) throw new Error('Usage: tsx scripts/intermission-smoke.ts PAUSED_SOURCE_WORLD PHYSICAL_IDENTITY');
const directory = await mkdtemp(join(tmpdir(), 'mom-intermission-'));
const source = await reconnectWorld(sourceId, sourceIdentity), initial = await source.state();
assert.equal(initial.phase, 'intermission');
const childId = `mom-intermission-${randomUUID()}`;
const children = await source.branch([childId]), child = children[0]; assert.ok(child);
const session = new Session({ decide: async () => { throw new Error('Intermission must not call Jev'); } },
  { threshold: .75, horizon: 210, branches: 2, paceMs: 0 });
try {
  await session.initialize(child); assert.deepEqual(await child.state(), initial);
  let turns = 0;
  while (session.snapshot().worlds[0]!.state.phase === 'intermission' && turns++ < 10) {
    session.step(); await session.idle(); assert.equal(session.snapshot().error, undefined);
  }
  const state = session.snapshot().worlds[0]!.state;
  assert.equal(state.phase, 'level'); assert.equal(state.map, initial.map + 1);
  assert.deepEqual(await source.state(), initial, 'the source must remain unchanged');
  await writeFile(join(directory, 'result.json'), JSON.stringify({ sourceId, childId, initial, state, turns,
    modelCalls: 0, sourceUnchanged: true }, null, 2));
  await writeFile(join(directory, 'next-level.png'), session.frame(childId));
  console.log(JSON.stringify({ directory, sourceId, childId, from: initial.map, to: state.map, elapsedTicks: state.tick - initial.tick }));
} finally {
  await session.close();
  await assert.rejects(Sandbox.get(childId), SandboxNotFoundError);
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ childAbsent: childId, sourceRetained: sourceId }));
}
