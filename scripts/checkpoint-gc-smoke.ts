import './runtime-env.ts';
import './build-bridge.ts';
import assert from 'node:assert/strict';
import { Snapshot } from 'microsandbox';
import { Session } from '../examples/doom/server/src/session.ts';
import { checkpoints } from '../examples/doom/server/src/checkpoints.ts';
import { createWorld } from '../examples/doom/server/src/runtime.ts';
const session = new Session({ decide: async () => { throw new Error('No model required'); } });
session.setCheckpointAdapter(checkpoints);
const run = `mom-checkpoint-gc-${Date.now()}`;
const references: string[] = [];
try {
  await session.initialize(await createWorld(run));
  for (let i = 0; i < 4; i++) {
    await session.saveRecoveryCheckpoint();
    references.push(session.checkpoint().recovery!.points.at(-1)!.reference);
  }
  const saved = session.checkpoint();
  assert.equal(saved.recovery!.points.length, 3);
  assert.deepEqual(saved.recovery!.cleanup, [references[0]]);
  const groups = new Set(references.map(r => r.split(':')[0]));
  const indexed = (await Snapshot.list()).filter(s => groups.has(s.group!));
  assert.equal(indexed.length, 4);
  assert.equal(indexed.filter(s => s.parentDigest !== null).length, 3);
  console.log('PASS: four real snapshots form a cross-group chain; eviction retains the needed oldest ancestor without an error.');
  await session.restart(() => createWorld(`${run}-restart`), async () => {});
  assert.equal(session.snapshot().error, undefined);
  assert.deepEqual(session.checkpoint().recovery!.cleanup, []);
  assert.equal((await Snapshot.list()).filter(s => groups.has(s.group!)).length, 0);
  assert.equal(session.snapshot().worlds[0]!.state.health, 100);
  console.log('PASS: restarting removes the whole chain child-first without force and preserves the fresh game.');
} finally { await session.close(); }
