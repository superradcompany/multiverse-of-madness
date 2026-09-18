import test from 'node:test';
import assert from 'node:assert/strict';
import { previousPlanFeedback } from './plan-feedback.ts';
import { startPlan, planInputs, type GamePlan } from './doom-plans.ts';
import { DoomMap } from './doom-geometry.ts';
import { initial } from '../test-support/fixture-runtime.ts';

const target = { kind: 'pickup' as const, engineType: 54, x: 100, y: 0, z: 0 };
const plan: GamePlan = { id: 'supply', label: 'collect supply', steps: [{ kind: 'move', label: 'reach supply', target, maxTicks: 70 }] };
test('zero-tick obstructions retain exact local target evidence without a positive-duration memory', () => {
  const state = { ...initial, x: 0, y: 0, z: 0, angle: 0, pickups: [{ kind: 'pickup' as const, engineType: 54, health: 1000,
    position: { x: 100, y: 0, z: 0 }, distance: 100, relativeBearing: 0, heading: 0, direction: { x: 1, y: 0 }, towardPlayerAlignment: -1 }] };
  const run = startPlan(plan, state, 210);
  assert.equal(previousPlanFeedback(run, state), undefined);
  planInputs(run, state, [], new DoomMap([{ a: { x: 50, y: -100 }, b: { x: 50, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 }]));
  const feedback = previousPlanFeedback(run, state)!;
  assert.equal(feedback.reason, 'target became obstructed'); assert.equal(feedback.status, 'replan');
  assert.equal(feedback.ticksSinceStarted, 0); assert.deepEqual(feedback.target, target);
  assert.equal(feedback.observedTick, state.tick); assert.equal(feedback.startedTick, state.tick);
  feedback.target!.x = 500;
  assert.equal(run.plan.steps[0]!.target.x, 100); assert.equal(run.tracked!.x, 100);
  assert.equal(previousPlanFeedback(run, { ...state, episode: 2 }), undefined);
  assert.equal(previousPlanFeedback(run, { ...state, map: 2 }), undefined);
  assert.equal(previousPlanFeedback(run, { ...state, tick: state.tick - 1 }), undefined);
});
