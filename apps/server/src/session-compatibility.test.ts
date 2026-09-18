import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from './session.ts';
import { SessionStore } from './persistence.ts';
import { Recordings } from './recordings.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

const fixture = fileURLToPath(new URL('../fixtures/session-fd777f7/', import.meta.url));
test('the pre-extraction producer session and replay can reconnect, promote and restore through the harness', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mom-legacy-compat-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const saved = await new SessionStore(join(fixture, 'session.json')).load();
  assert.ok(saved);
  await cp(join(fixture, 'recordings'), join(temporary, 'recordings'), { recursive: true });
  const recordings = new Recordings(join(temporary, 'recordings'));
  await recordings.open();
  recordings.protect(saved.worlds.map(world => world.view.id));
  for (const world of saved.worlds) {
    const last = recordings.list().worlds.find(record => record.id === world.view.id)!;
    const frame = await recordings.get(world.view.id, last.frames - 1);
    assert.deepEqual(frame.world.state, world.view.state);
    assert.equal(frame.frame, world.frame);
  }
  const runtimes = new Map(saved.worlds.map(world => [world.view.id, new Runtime(world.view.id, structuredClone(world.view.state))]));
  const checkpoints = new Map(saved.recovery!.points.map(point => [point.reference, structuredClone(point.world.state)]));
  const session = new Session({ decide: async () => decision }, { threshold: 0.75, horizon: 7, branches: 2, paceMs: 0 });
  session.setCheckpointAdapter({
    capture: async (runtime, reference) => { checkpoints.set(reference, await runtime.state()); },
    restore: async (reference, id) => {
      const runtime = new Runtime(id, structuredClone(checkpoints.get(reference)!));
      runtimes.set(id, runtime); return runtime;
    },
    remove: async reference => { checkpoints.delete(reference); },
  });
  session.setRecorder((world, frame) => recordings.record(world, frame));
  session.setMainRecorder(id => recordings.retainPath(id));
  const store = new SessionStore(join(temporary, 'session.json'));
  session.setPersistence(checkpoint => store.save(checkpoint));
  await session.restore(saved, async (id, identity) => {
    const runtime = runtimes.get(id)!;
    assert.equal(runtime.identity, identity); return runtime;
  });
  assert.equal(session.snapshot().mainId, saved.view.mainId);
  assert.equal(session.snapshot().stage, 'choosing');
  assert.deepEqual(session.checkpoint().experience, saved.experience);
  assert.deepEqual(session.snapshot().worlds.map(world => world.state), saved.worlds.map(world => world.view.state));
  const winner = saved.experiments[0]!.id;
  await session.promote(winner);
  assert.equal(session.snapshot().mainId, winner);
  const selected = await recordings.path(winner);
  assert.equal(selected.missingHistory, false);
  assert.deepEqual(selected.segments.flatMap(segment => segment.ticks), [35, 42]);
  const point = saved.recovery!.points[0]!;
  await session.rollback(point.id);
  const restored = session.snapshot().worlds.find(world => world.id === session.snapshot().mainId)!;
  assert.deepEqual(restored.state, point.world.state);
  assert.equal(session.snapshot().stats!.seconds, point.stats.ticks / 35);
  await recordings.flush();
  const replay = await recordings.path(restored.id);
  assert.equal(replay.missingHistory, false);
  assert.deepEqual(replay.segments.flatMap(segment => segment.ticks), [35]);
  await store.flush();
  assert.equal((await store.load())!.view.mainId, restored.id);
  await session.close();
});
