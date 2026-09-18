import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionStateIsCurrent } from './doom-decision-freshness.ts';
import { initial } from '../test-support/fixture-runtime.ts';
import { startPlan } from './doom-plans.ts';

test('prefetch accepts bounded motion but refuses changed resources, actors, level, doors and old observations', () => {
  const moved = { ...initial, tick: initial.tick + 20, x: initial.x + 80, angle: 90 };
  assert.equal(decisionStateIsCurrent(initial, moved), true);
  for (const patch of [{ health: 99 }, { armor: 1 }, { ammo: [49, 0, 0, 0] }, { kills: 1 }, { items: 1 }, { map: 2 },
    { tick: initial.tick + 29 }, { x: initial.x + 129 }, { z: initial.z + 4 }, { alive: false }, { keys: ['red' as const] },
    { progressEvents: [{ tick: initial.tick + 1, kind: 'door' as const, sector: 1, direction: 1 }] }]) {
    assert.equal(decisionStateIsCurrent(initial, { ...moved, ...patch }), false, JSON.stringify(patch));
  }
  const plan = startPlan({ id: 'route', label: 'route', steps: [{ kind: 'move', label: 'move', target: { kind: 'point', x: 100, y: 0, z: 0 }, maxTicks: 35 }] }, initial, 35);
  plan.status = 'replan'; plan.reason = 'route blocked';
  assert.equal(decisionStateIsCurrent(initial, moved, plan), false);
});

test('moving actor tracking stays bounded; new threats and unavailable or ambiguous targets invalidate plans', () => {
  const enemy = { kind: 'enemy' as const, engineType: 3004, health: 20, position: { x: 300, y: 0, z: 0 }, distance: 300,
    relativeBearing: 0, heading: 0, direction: { x: 1, y: 0 }, towardPlayerAlignment: 0 };
  const before = { ...initial, enemies: [enemy] };
  const current = { ...before, tick: before.tick + 14, enemies: [{ ...enemy, position: { ...enemy.position, x: 280 }, distance: 280 }] };
  const plan = { id: 'attack', label: 'attack', steps: [{ kind: 'attack' as const, label: 'attack',
    target: { kind: 'enemy' as const, engineType: enemy.engineType, ...enemy.position }, maxTicks: 35 }] };
  assert.equal(decisionStateIsCurrent(before, current, undefined, [plan]), true);
  assert.equal(decisionStateIsCurrent(before, { ...current, enemies: [] }, undefined, [plan]), false);
  assert.equal(decisionStateIsCurrent(before, { ...current, enemies: [{ ...current.enemies[0]!, health: 10 }] }), false);
  assert.equal(decisionStateIsCurrent(before, { ...current, enemies: [{ ...current.enemies[0]!, distance: 150 }] }), false);
  assert.equal(decisionStateIsCurrent(before, { ...current, enemies: [{ ...current.enemies[0]!, position: { x: 203, y: 0, z: 0 } }] }), false);
  assert.equal(decisionStateIsCurrent(before, current, undefined, [{ ...plan, steps: [{ ...plan.steps[0]!, target: { ...plan.steps[0]!.target, x: 900 } }] }]), false);
});

test('pickup ordering and distant observation changes do not invalidate navigation; new nearby supplies do', () => {
  const pickup = (x: number) => ({ kind: 'pickup' as const, engineType: 2011, health: 0, position: { x, y: 0, z: 0 }, distance: x,
    relativeBearing: 0, heading: 0, direction: { x: 0, y: 0 }, towardPlayerAlignment: 0 });
  const before = { ...initial, pickups: [pickup(300), pickup(400)] };
  assert.equal(decisionStateIsCurrent(before, { ...before, pickups: [...before.pickups].reverse() }), true);
  assert.equal(decisionStateIsCurrent(before, { ...before, pickups: [pickup(300), pickup(600)] }), true);
  assert.equal(decisionStateIsCurrent(before, { ...before, pickups: [pickup(100), pickup(300)] }), false);
  const plan = { id: 'collect', label: 'collect', steps: [{ kind: 'move' as const, label: 'move',
    target: { kind: 'pickup' as const, engineType: 2011, x: 400, y: 0, z: 0 }, maxTicks: 35 }] };
  assert.equal(decisionStateIsCurrent(before, { ...before, pickups: [pickup(300)] }, undefined, [plan]), false);
});
