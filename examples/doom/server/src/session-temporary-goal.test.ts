import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, type SessionCheckpoint } from './session.ts';
import { SessionStore } from './persistence.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { proposeDoomTemporaryGoal } from './doom-temporary-goal.ts';
import type { DecisionMaker } from './jev.ts';

const model: DecisionMaker = { decide: async (state, _objective, _history, _signal, _experience, _ticks, context) => ({
  ...structuredClone(decision), confidence: 1,
  temporaryGoal: proposeDoomTemporaryGoal({ key: 'opening', instruction: 'Reach another opening', reason: 'Try an alternative route', evidence: ['current-state'], duration: 70,
    target: { kind: 'position', x: 100, y: 0, z: 0, within: 8 } }, context?.temporaryGoal, state),
}) };
const options = { threshold: 0, horizon: 35, branches: 2, paceMs: 0 };
async function oneDecision(session: Session) {
  let paused: Promise<void> | undefined;
  session.setRecorder(async () => { paused ??= session.pause(); });
  session.resume(); await session.idle(); await paused;
  assert.equal(session.snapshot().error, undefined);
}

test('session saves and restores a goal without renewing it, then invalidates it when the user guide changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-goal-session-'));
  const runtime = new Runtime('goal-persistence'), session = new Session(model, options);
  const restored = new Session(model, options), store = new SessionStore(join(directory, 'session.json'));
  try {
    await session.initialize(runtime); session.setPlanningMode('actions'); session.setPersistence(saved => store.save(saved));
    await oneDecision(session);
    const saved = await store.load() as SessionCheckpoint;
    assert.equal(saved.version, 3); assert.ok(saved.goalScopeId);
    const original = saved.worlds[0]!.view.temporaryGoal!;
    await restored.restore(saved, async () => runtime);
    assert.equal(restored.snapshot().worlds[0]!.temporaryGoal!.record.id, original.record.id);
    await oneDecision(restored);
    assert.equal(restored.snapshot().worlds[0]!.temporaryGoal!.record.expiresAt, original.record.expiresAt);
    restored.queueObjective('Conserve ammunition'); await oneDecision(restored);
    assert.equal(restored.snapshot().objective, 'Conserve ammunition');
    assert.equal(restored.snapshot().worlds[0]!.temporaryGoal!.record.status, 'invalidated');
    const corrupt = structuredClone(saved); corrupt.version = 2;
    await assert.rejects(new Session(model, options).restore(corrupt, async () => runtime));
    const wrongRun = structuredClone(saved); wrongRun.goalScopeId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(new Session(model, options).restore(wrongRun, async () => runtime), /another run/);
    await restored.restart(async () => new Runtime('new-game'), async () => {});
    assert.equal(restored.snapshot().worlds[0]!.temporaryGoal, undefined);
    assert.equal(restored.checkpoint().version, 1);
  } finally { await session.close(); await restored.close(); await rm(directory, { recursive: true, force: true }); }
});

test('forked futures inherit independent copies of the goal and its original deadline', async () => {
  const session = new Session({ decide: async (...args) => ({ ...await model.decide(...args), confidence: 0 }) }, { ...options, threshold: 1 });
  try {
    await session.initialize(new Runtime('goal-fork')); session.setPlanningMode('actions');
    let paused: Promise<void> | undefined;
    session.setRecorder(async world => { if (world.role === 'experiment' && world.state.tick > 35) paused ??= session.pause(); });
    session.resume(); await session.idle(); await paused;
    assert.equal(session.snapshot().error, undefined);
    const views = session.snapshot().worlds;
    const source = views.find(world => world.role === 'main')!;
    const children = views.filter(world => world.role === 'experiment');
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.temporaryGoal!.record.id, source.temporaryGoal!.record.id);
      assert.equal(child.temporaryGoal!.record.expiresAt, source.temporaryGoal!.record.expiresAt);

    }
    assert.ok(children.some(child => child.temporaryGoal!.record.checked.clock.value > source.temporaryGoal!.record.checked.clock.value));
  } finally { await session.close(); }
});


test('checkpoint rollback retains the original deadline and invalidates goals from a different guide', async () => {
  const states = new Map<string, Awaited<ReturnType<Runtime['state']>>>();
  const session = new Session(model, options);
  session.setCheckpointAdapter({
    capture: async (runtime, reference) => { states.set(reference, await runtime.state()); },
    restore: async (reference, id) => new Runtime(id, structuredClone(states.get(reference)!)),
    remove: async reference => { states.delete(reference); },
  });
  try {
    await session.initialize(new Runtime('goal-checkpoint')); session.setPlanningMode('actions');
    await oneDecision(session); session.setRecorder(async () => {});
    await session.saveRecoveryCheckpoint();
    const point = session.checkpoint().recovery!.points[0]!;
    const original = point.world.temporaryGoal!;
    await oneDecision(session); session.setRecorder(async () => {});
    await session.rollback(point.id);
    assert.equal(session.snapshot().worlds.find(world => world.id === session.snapshot().mainId)!.temporaryGoal!.record.expiresAt, original.record.expiresAt);
    session.queueObjective('Avoid all combat'); await oneDecision(session); session.setRecorder(async () => {});
    await session.rollback(point.id);
    const restored = session.snapshot().worlds.find(world => world.id === session.snapshot().mainId)!;
    assert.equal(restored.temporaryGoal!.record.status, 'invalidated');
    assert.equal(restored.temporaryGoal!.record.expiresAt, original.record.expiresAt);
    assert.equal(session.checkpoint().version, 3);
  } finally { await session.close(); }
});
