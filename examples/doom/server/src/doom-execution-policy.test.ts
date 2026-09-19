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

test('navigation alignment is tunable independently from combat and preserves historical defaults', () => {
  const historical = { ...defaultDoomExecutionPolicy };
  assert.deepEqual(doomExecutionPolicySchema.parse(historical), historical, 'omission must not inject fields into historical hashes');
  const execution = { ...historical, navigationAlignmentDegrees: 3, movementAlignmentDegrees: 10 };
  const bearing = 5 * Math.PI / 180;
  const enemy = { kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 100 * Math.cos(bearing), y: 100 * Math.sin(bearing), z: 0 },
    distance: 100, relativeBearing: 5, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 };
  const combatState = { ...initial, enemies: [enemy] };
  const combat = startPlan({ id: 'combat', label: 'combat', steps: [{ kind: 'face', label: 'aim', maxTicks: 140,
    target: { ...enemy.position, kind: 'enemy', engineType: 1 } }] }, combatState, 140);
  planInputs(combat, combatState, [], undefined, execution);
  assert.equal(combat.status, 'complete', 'combat retains its motor aim tolerance');
  for (const sign of [-1, 1]) for (const kind of ['face', 'move', 'use'] as const) {
    const bearing = sign * (kind === 'move' ? 20 : 5), radians = bearing * Math.PI / 180;
    const target = { kind: 'point' as const, x: 32 * Math.cos(radians), y: 32 * Math.sin(radians), z: 0 };
    const plan: GamePlan = { id: kind, label: kind, steps: [{ kind, label: kind, maxTicks: 140, target }] };
    const old = startPlan(plan, initial, 140), tuned = startPlan(plan, initial, 140);
    const oldInputs = planInputs(old, initial, []);
    assert.deepEqual(oldInputs, kind === 'face' ? [] : kind === 'use' ? ['use'] : ['forward', 'use']);
    assert.deepEqual(planInputs(tuned, initial, [], undefined, execution), [sign > 0 ? 'left' : 'right']);
    // Aligning within the configured threshold must let the step progress.
    const aligned = { ...initial, angle: bearing - sign * 2 };
    const inputs = planInputs(tuned, aligned, [], undefined, execution);
    assert.deepEqual(inputs, kind === 'face' ? [] : kind === 'use' ? ['use'] : ['forward', 'use']);
  }
  for (const patch of [{ navigationAlignmentDegrees: 0 }, { navigationAlignmentDegrees: 21 },
    { movementAlignmentDegrees: 0 }, { movementAlignmentDegrees: 91 }, { movementAlignmentDegrees: Infinity }]) {
    assert.throws(() => doomExecutionPolicySchema.parse({ ...execution, ...patch }));
  }
  const outside = startPlan({ ...move, steps: [{ ...move.steps[0]!, kind: 'use' }] }, initial, 140);
  assert.deepEqual(planInputs(outside, initial, [], undefined, execution), []);
  assert.equal(outside.reason, 'interaction out of reach');
});
