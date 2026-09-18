import './runtime-env.ts';
import './build-bridge.ts';
import assert from 'node:assert/strict';
import { Session } from '../examples/doom/server/src/session.ts';
import { checkpoints } from '../examples/doom/server/src/checkpoints.ts';
import { Recordings } from '../examples/doom/server/src/recordings.ts';
import { SessionStore } from '../examples/doom/server/src/persistence.ts';
import { createWorld, reconnectWorld, recoverPendingWorld, destroyWorld } from '../examples/doom/server/src/runtime.ts';
const session = new Session({ decide: async () => { throw new Error('No model is needed for a snapshot identity check'); } });
session.setCheckpointAdapter(checkpoints);
const store = new SessionStore('.cache/checkpoint-smoke.json');
const recordings = new Recordings('.cache/checkpoint-smoke-recordings');
await recordings.open();
session.setRecorder((world, frame) => recordings.record(world, frame));
session.setMainRecorder(id => recordings.retainPath(id));
session.setPersistence(c => store.save(c));
if (process.argv[2] === 'capture') {
  await session.initialize(await createWorld(`mom-checkpoint-smoke-${Date.now()}`));
  await session.saveRecoveryCheckpoint();
  const id = session.snapshot().mainId;
  await session.takeover(id); await session.input(id, ['forward']); session.release(id);
  await session.saveRecoveryCheckpoint();
  await session.takeover(id); await session.input(id, ['forward']); session.release(id);
  await session.pause(); await recordings.flush(); await store.flush();
  console.log('Captured two full VM checkpoints, then moved beyond both. Exiting host.');
  process.exit(0);
} else {
  const saved = await store.load(); assert.ok(saved);
  try {
    await session.restore(saved, reconnectWorld, recoverPendingWorld, destroyWorld);
    const point = session.snapshot().recovery!.checkpoints[0]!;
    const expected = saved.recovery!.points[0]!.world.state;
    await session.rollback(point.id);
    const restored = session.snapshot();
    assert.deepEqual(restored.worlds.find(w => w.id === restored.mainId)!.state, expected);
    assert.equal(restored.recovery!.checkpoints.length, 1);
    assert.equal(restored.stats!.attempts.rollbacks, 1);
    assert.equal(restored.stats!.seconds, 0);
    const id = restored.mainId;
    await session.takeover(id); await session.input(id, ['right']); session.release(id);
    await recordings.flush();
    const path = await recordings.path(id);
    assert.equal(path.missingHistory, false);
    assert.deepEqual(path.segments.flatMap(s => s.ticks), [35, 36]);
    console.log('PASS: real full snapshot survived host exit, restored exact game state, deleted newer checkpoint, and replay followed the rollback route.');
  } finally { await session.close(); }
}
