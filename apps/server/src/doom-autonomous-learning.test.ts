import test from 'node:test';
import assert from 'node:assert/strict';
import { observeDoomLearning, doomAutonomousState, supervisorReviewIntervalMs, DoomGoalReview, doomAutomaticProposalKind } from './doom-autonomous-learning.ts';
import { Session } from './session.ts';
import { decision, Runtime } from '../test-support/fixture-runtime.ts';

test('healthy play makes no supervisor calls; unchanged failure clusters are analyzed at most once per issue type', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(); assert.equal(observeDoomLearning(view), undefined);
  view.stats!.attempts.seconds = 600; assert.equal(observeDoomLearning(view), undefined);
  view.stats!.stalledSeconds = 16;
  const stalled = observeDoomLearning(view)!; assert.match(stalled.reason, /no useful progress/);
  view.stats!.attempts.seconds = 1200; assert.equal(observeDoomLearning(view, stalled.mark), undefined);
  view.stats!.attempts.planFailures = 3;
  let now = stalled.mark.observedAt! + supervisorReviewIntervalMs;
  const missing = observeDoomLearning(view, stalled.mark, now)!; assert.equal(missing.mark.issues.at(-1), 'plan-coverage');
  now += supervisorReviewIntervalMs;
  view.stats!.attempts.planFailures = 100; assert.equal(observeDoomLearning(view, missing.mark, now), undefined);
  view.stats!.attempts.seconds = 2000; assert.equal(observeDoomLearning(view, missing.mark, now), undefined);
  view.stats!.kills++; assert.ok(observeDoomLearning(view, missing.mark, now), 'new meaningful progress permits reevaluation');
  view.stats!.attempts.seconds = 0; view.stats!.attempts.planFailures = 0; view.stats!.stalledSeconds = 0;
  assert.equal(observeDoomLearning(view, missing.mark), undefined);
  view.stats!.attempts.planFailures = 3;
  assert.ok(observeDoomLearning(view), 'repeated zero-tick failures escalate without waiting for game time');
  assert.throws(() => doomAutonomousState.parse({ version: 2, enabled: true }));
});

test('persisted request spacing prevents state changes or resets causing rapid supervisor calls', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(); view.stats!.attempts.planFailures = 3;
  const first = observeDoomLearning(view, undefined, 1000)!;
  const restored = doomAutonomousState.parse({ version: 1, enabled: true, lastObservation: first.mark });
  view.stats!.attempts.planFailures = 6; view.stats!.kills++;
  assert.equal(observeDoomLearning(view, restored.lastObservation, 1001), undefined);
  assert.ok(observeDoomLearning(view, restored.lastObservation, 1000 + supervisorReviewIntervalMs));
  view.stats!.attempts.planFailures = 0;
  assert.equal(observeDoomLearning(view, restored.lastObservation, 1001), undefined);
  view.stats!.attempts.planFailures = 3; view.stats!.stalledSeconds = 0;
  assert.equal(observeDoomLearning(view, restored.lastObservation, 1000 + supervisorReviewIntervalMs), undefined, 'time alone never triggers analysis');
});

test('occasional failed futures do not call the supervisor; repeated failures are coalesced', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot();
  view.stats!.attempts.deaths = 1;
  assert.equal(observeDoomLearning(view), undefined);
  view.stats!.attempts.rejectedBatches = 1;
  assert.equal(observeDoomLearning(view), undefined);
  view.stats!.attempts.rollbacks = 1;
  const failed = observeDoomLearning(view)!;
  assert.equal(failed.mark.issues.at(-1), 'failed-outcomes');
  view.stats!.attempts.deaths = 50;
  assert.equal(observeDoomLearning(view, failed.mark), undefined);
});

test('tested revisions apply inside the owned gameplay turn before the next decision without stopping play', async () => {
  let session!: Session, seen = false, applied = 0;
  session = new Session({ decide: async () => {
    assert.equal(applied, 1); seen = session.snapshot().running;
    return { ...decision, confidence: 1 };
  } }, { threshold: .75, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
  await session.initialize(new Runtime('root')); session.setPersistence(async () => {});
  session.queueLearningActivation('revision', () => session.revisionBoundary(async () => { applied++; }));
  let stopped = false;
  session.on('change', () => { if (seen && !stopped) { stopped = true; void session.pause(); } });
  session.resume(); await session.idle();
  assert.equal(applied, 1); assert.equal(seen, true); assert.equal(session.snapshot().error, undefined);
  assert.equal(session.queueLearningActivation('revision', async () => { throw new Error('duplicate publication'); }), 'activated');
});

test('a failed background activation does not crash gameplay and cancellation removes a queued change', async () => {
  const session = new Session({ decide: async () => ({ ...decision, confidence: 1 }) }, { threshold: .75, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
  await session.initialize(new Runtime('root')); session.setPersistence(async () => {});
  session.queueLearningActivation('cancelled', async () => { throw new Error('must not execute'); }); session.cancelLearningActivation('cancelled');
  session.queueLearningActivation('failed', async () => { throw new Error('candidate is stale'); });
  session.step(); await session.idle();
  assert.equal(session.snapshot().error, undefined);
  assert.throws(() => session.queueLearningActivation('failed', async () => {}), /candidate is stale/);
  assert.ok(session.snapshot().worlds.some(world => world.state.tick > 35));
});


test('planner bootstrap uses initial real experience once and does not ask again during healthy play', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(); view.planningMode = 'plans'; view.stats!.attempts.seconds = 9;
  assert.equal(observeDoomLearning(view, undefined, 1000, { bootstrapPlanner: true }), undefined);
  view.stats!.attempts.seconds = 10;
  const first = observeDoomLearning(view, undefined, 1000, { bootstrapPlanner: true })!;
  assert.equal(first.mark.issues.at(-1), 'strategy-bootstrap');
  view.stats!.attempts.seconds = 600;
  assert.equal(observeDoomLearning(view, first.mark, 1000 + supervisorReviewIntervalMs, { bootstrapPlanner: true }), undefined);
});

test('persistent stalls can be reviewed again with fresh selected gameplay, without repeated calls every turn', async () => {
  const { supervisorPersistentReviewIntervalMs } = await import('./doom-autonomous-learning.ts');
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot();
  view.stats!.seconds = 60; view.stats!.stalledSeconds = 60; view.stats!.attempts.seconds = 240;
  const first = observeDoomLearning(view, undefined, 1000)!;
  const later = 1000 + supervisorPersistentReviewIntervalMs;
  assert.equal(observeDoomLearning(view, first.mark, later), undefined, 'paused games do not spend tokens');
  view.stats!.seconds += 60; view.stats!.attempts.seconds += 240;
  assert.equal(observeDoomLearning(view, first.mark, later - 1), undefined);
  const repeated = observeDoomLearning(view, first.mark, later)!;
  assert.equal(repeated.mark.key, first.mark.key); assert.deepEqual(repeated.mark.issues, ['stalled-progress']);
  assert.equal(observeDoomLearning(view, repeated.mark, later + 1), undefined);
});

test('stalled conditional play requests new options instead of a guidance-only change', async () => {
  const { doomAutomaticProposalKind } = await import('./doom-autonomous-learning.ts');
  assert.equal(doomAutomaticProposalKind('stalled-progress', 'plans'), 'planner');
  assert.equal(doomAutomaticProposalKind('plan-coverage', 'plans'), 'planner');
  assert.equal(doomAutomaticProposalKind('stalled-progress', 'actions'), 'guidance', 'respect explicit single-action mode');
});


test('an applied user goal schedules one review without requiring stalled or failed gameplay', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(), initialObjective = view.objective;
  const options = { initialObjective, goalSettled: true };
  assert.equal(observeDoomLearning(view, undefined, 1000, options), undefined);
  view.objective = 'Prioritize enemies and preserve ammunition';
  const changed = observeDoomLearning(view, undefined, 1000, options)!;
  assert.equal(changed.mark.objective, view.objective);
  assert.deepEqual(changed.mark.issues, ['goal-changed']);
  assert.equal(doomAutomaticProposalKind('goal-changed', 'plans'), 'planner');
  assert.equal(doomAutomaticProposalKind('goal-changed', 'actions'), 'guidance');
  const restored = doomAutonomousState.parse({ version: 1, enabled: true, lastObservation: changed.mark });
  assert.equal(observeDoomLearning(view, restored.lastObservation, 1000 + supervisorReviewIntervalMs, options), undefined);
  view.objective = 'Reach the exit while avoiding combat';
  assert.equal(observeDoomLearning(view, restored.lastObservation, 1001, options), undefined, 'goal edits respect paid review spacing');
  const next = observeDoomLearning(view, restored.lastObservation, 1000 + supervisorReviewIntervalMs, options)!;
  assert.equal(next.mark.objective, view.objective);
});

test('rapid edits coalesce to the latest applied goal and queued goals cannot generate stale guidance', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(), goals = new DoomGoalReview(view.objective);
  const observe = (now: number) => observeDoomLearning(view, undefined, now, {
    initialObjective: goals.initialObjective, goalSettled: goals.settled(view.pendingObjective ?? view.objective, now),
  });
  assert.equal(observe(0), undefined);
  view.pendingObjective = 'Find ammunition';
  view.stats!.attempts.planFailures = 10;
  assert.equal(observe(1000), undefined);
  assert.equal(observe(5000), undefined, 'even failure reviews wait for the new goal to apply');
  view.pendingObjective = 'Avoid combat and reach the exit';
  assert.equal(observe(5001), undefined);
  view.objective = view.pendingObjective; delete view.pendingObjective;
  view.stats!.attempts.planFailures = 0;
  assert.equal(observe(8000), undefined);
  const latest = observe(8001)!;
  assert.equal(latest.mark.objective, 'Avoid combat and reach the exit');
  assert.equal(latest.mark.issues.at(-1), 'goal-changed');
});

test('legacy observation records remain readable and establish the current goal without inventing an edit', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot(); view.stats!.stalledSeconds = 20; view.stats!.attempts.seconds = 60;
  const mark = observeDoomLearning(view, undefined, 1000)!.mark; delete mark.objective;
  const saved = doomAutonomousState.parse({ version: 1, enabled: true, lastObservation: mark });
  view.stats!.stalledSeconds = 0;
  const options = { initialObjective: view.objective, goalSettled: true };
  assert.equal(observeDoomLearning(view, saved.lastObservation, 1000 + supervisorReviewIntervalMs, options), undefined);
  view.objective = 'Collect health';
  assert.equal(observeDoomLearning(view, saved.lastObservation, 1000 + supervisorReviewIntervalMs, options)!.mark.issues.at(-1), 'goal-changed');
});

test('a newly applied planner needs new failure evidence and review spacing before another proposal', async () => {
  const { doomActivationObservation } = await import('./doom-autonomous-learning.ts');
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('root'));
  const view = session.snapshot();
  view.stats!.seconds = 100; view.stats!.attempts.seconds = 400;
  view.stats!.attempts.planFailures = 100; view.stats!.stalledSeconds = 90;
  const old = observeDoomLearning(view, undefined, 1000)!;
  view.stats!.seconds = 220; view.stats!.attempts.seconds = 880; view.stats!.attempts.planFailures = 180;
  const now = 1000 + supervisorReviewIntervalMs * 3;
  const mark = doomActivationObservation(view, now);
  assert.deepEqual(mark.issues, []); assert.equal(mark.planFailures, 180);
  const restored = doomAutonomousState.parse({ version: 1, enabled: true, lastObservation: mark });
  assert.equal(observeDoomLearning(view, restored.lastObservation, now + supervisorReviewIntervalMs), undefined, 'old stalls alone cannot trigger paid work while paused');
  view.stats!.attempts.planFailures += 3;
  assert.equal(observeDoomLearning(view, mark, now + 1), undefined, 'a slow previous evaluation does not exhaust the new review spacing');
  assert.equal(observeDoomLearning(view, mark, now + supervisorReviewIntervalMs)!.mark.issues[0], 'plan-coverage', 'fresh zero-tick failures still escalate');
  assert.equal(old.mark.planFailures, 100, 'original incident evidence stays unchanged');
  assert.throws(() => doomActivationObservation({ ...view, stats: undefined }), /current main world/);
});
