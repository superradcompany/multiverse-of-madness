import test from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../test-support/fixture-runtime.ts';
import { planInputs, startPlan, type GamePlan } from './doom-plans.ts';
import { defaultDoomExecutionPolicy, doomExecutionPolicySchema } from './doom-execution-policy.ts';
import { DoomMap } from './doom-geometry.ts';

const move: GamePlan = { id: 'move', label: 'move', steps: [{ kind: 'move', label: 'approach', maxTicks: 140, target: { kind: 'point', x: 128, y: 0, z: 0 } }] };

test('execution settings change damage and blocked-plan interruption without disabling observation checks', () => {
  const execution = { ...defaultDoomExecutionPolicy, damageBeforeReplan: 2, blockedAfterTicks: 8 };
  const hurt = { ...initial, tick: initial.tick + 1, health: 98 };
  const cautious = startPlan(move, initial, 140), historical = startPlan(move, initial, 140);
  planInputs(cautious, hurt, [], undefined, execution);
  planInputs(historical, hurt, []);
  assert.equal(cautious.reason, 'taking damage'); assert.equal(historical.status, 'running');
  const current = { ...initial, tick: initial.tick + 8 };
  const history = Array.from({ length: 8 }, (_, index) => ({ ...initial, tick: initial.tick + index }));
  const blocked = startPlan(move, initial, 140), old = startPlan(move, initial, 140);
  planInputs(blocked, current, history, undefined, execution); planInputs(old, current, history);
  assert.equal(blocked.reason, 'route blocked'); assert.equal(old.status, 'running');
  const moving = startPlan(move, initial, 140);
  planInputs(moving, current, history.map((state, index) => ({ ...state, x: index * 4 })), undefined, execution);
  assert.equal(moving.status, 'running');
});

test('threat distance is adjustable but walls still exclude an obstructed new threat', () => {
  const state = { ...initial, enemies: [{ kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 200, y: 0, z: 0 }, distance: 200,
    relativeBearing: 0, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 }] };
  const execution = { ...defaultDoomExecutionPolicy, nearbyThreatDistance: 256 };
  const alert = startPlan(move, initial, 140), old = startPlan(move, initial, 140), blocked = startPlan(move, initial, 140);
  planInputs(alert, state, [], new DoomMap([]), execution); planInputs(old, state, []);
  planInputs(blocked, state, [], new DoomMap([{ a: { x: 100, y: -64 }, b: { x: 100, y: 64 }, blocksSight: true, blocksMovement: true, special: 0 }]), execution);
  assert.equal(alert.reason, 'new nearby threat'); assert.equal(old.status, 'running'); assert.equal(blocked.status, 'running');
});

test('interaction cadence retains released frames and the engine reach restriction', () => {
  const plan: GamePlan = { id: 'use', label: 'use', steps: [{ ...move.steps[0]!, kind: 'use', target: { kind: 'point', x: 32, y: 0, z: 0 } }] };
  const execution = { ...defaultDoomExecutionPolicy, usePulseTicks: 2 }, run = startPlan(plan, initial, 140);
  assert.deepEqual(Array.from({ length: 5 }, (_, tick) => planInputs(run, { ...initial, tick: initial.tick + tick }, [], undefined, execution)), [['use'], [], ['use'], [], ['use']]);
  const outside = startPlan({ ...plan, steps: [{ ...plan.steps[0]!, target: { kind: 'point', x: 65, y: 0, z: 0 } }] }, initial, 140);
  assert.deepEqual(planInputs(outside, initial, [], undefined, execution), []); assert.equal(outside.reason, 'interaction out of reach');
  assert.throws(() => doomExecutionPolicySchema.parse({ ...execution, usePulseTicks: 1 }));
  assert.throws(() => doomExecutionPolicySchema.parse({ ...execution, damageBeforeReplan: 0 }));
  assert.throws(() => doomExecutionPolicySchema.parse({ ...execution, blockedAfterTicks: Infinity }));
});
