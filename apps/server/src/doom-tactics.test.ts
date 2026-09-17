import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameState } from '../../../packages/contracts/src/game.ts';
import type { EntityObservation } from '../../../packages/contracts/src/entity.ts';
import { DoomMap } from './doom-geometry.ts';
import { candidatePlans, planInputs, startPlan } from './doom-plans.ts';
import { interactionPlans, resourcePlans, tacticalPlans, rememberedPickupPlans } from './doom-tactics.ts';
import { observePickups, pickupMemoryPolicy } from './doom-pickup-memory.ts';
import { doomPlanPolicy } from './doom-plan-policy.ts';

const initial: GameState = { tick: 35, health: 100, armor: 0, ammo: [50, 0, 0, 0], weapon: 'pistol', kills: 0, items: 0, secrets: 0, x: 0, y: 0, z: 0, angle: 0, episode: 1, map: 1, phase: 'level', alive: true, velocity: { x: 0, y: 0, z: 0 }, enemies: [], projectiles: [], pickups: [], telemetry: { radius: 2048, lineOfSightKnown: false, engineObjectCount: 1 } };
const entity = (engineType: number, x: number, y = 0, kind: EntityObservation['kind'] = 'pickup'): EntityObservation => ({ engineType, position: { x, y, z: 0 }, kind, health: 20, distance: Math.hypot(x, y), relativeBearing: Math.atan2(y, x) * 180 / Math.PI, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 });
const wall = (special: number, x = 96) => ({ a: { x, y: -100 }, b: { x, y: 100 }, blocksSight: true, blocksMovement: true, special });
const useWall = (special: number) => ({ ...wall(special), a: wall(special).b, b: wall(special).a });
const open = new DoomMap([]);

test('resource candidates need observed useful resources and an approachable route', () => {
  const s = { ...initial, pickups: [entity(69, 64), entity(77, 80), entity(47, 96), entity(43, 100)] };
  assert.deepEqual(resourcePlans(s, open).map(p => p.label), ['replenish ammunition', 'collect shotgun', 'collect a nearby key', 'collect armor']);
  assert.equal(resourcePlans(s, new DoomMap([wall(0, 32)])).length, 0);
  const full = { ...s, armor: 200, ammo: [200, 50, 300, 50], weapon: 'shotgun' };
  assert.deepEqual(resourcePlans(full, open).map(p => p.label), ['collect a nearby key']);
});

test('use plans select the front side, exclude locked and non-use lines, and pulse use', () => {
  for (const special of [1, 11, 51, 103]) assert.equal(interactionPlans(initial, new DoomMap([useWall(special)])).length, 1);
  for (const special of [0, 26, 27, 28, 39, 124]) assert.equal(interactionPlans(initial, new DoomMap([useWall(special)])).length, 0);
  assert.equal(interactionPlans({ ...initial, x: 160 }, new DoomMap([useWall(1)])).length, 0);
  const map = new DoomMap([useWall(1)]), plan = interactionPlans(initial, map)[0]!;
  const run = startPlan(plan, initial, 210);
  assert.deepEqual(planInputs(run, initial, [], map), ['forward', 'use']);
  const arrived = { ...initial, tick: 36, x: 64 };
  assert.deepEqual(planInputs(run, arrived, [], map), ['use']);
  assert.deepEqual(planInputs(run, { ...arrived, tick: 37 }, [], map), []);
  planInputs(run, { ...arrived, tick: 71 }, [], map);
  assert.equal(run.status, 'replan'); assert.match(run.reason!, /interaction attempted/);
});

test('moving combat needs lateral clearance, stops at walls, and turns before firing', () => {
  const enemy = entity(1, 128, 0, 'enemy'), s = { ...initial, enemies: [enemy] };
  const p = tacticalPlans(s, open, enemy, true).find(p => p.id === 'strafe_attack')!;
  assert.ok(p);
  assert.deepEqual(planInputs(startPlan(p, s, 210), s, [], open), ['strafeLeft', 'fire']);
  const run = startPlan(p, s, 210); planInputs(run, s, [], open);
  const turned = planInputs(run, { ...s, tick: 36, angle: 15 }, [], open);
  assert.ok(turned.includes('strafeLeft')); assert.ok(turned.includes('right')); assert.ok(!turned.includes('fire'));
  const blocked = new DoomMap([{ ...wall(0), a: { x: -100, y: 30 }, b: { x: 200, y: 30 } }]);
  planInputs(run, { ...s, tick: 37 }, [], blocked); assert.equal(run.reason, 'strafe route blocked');
  assert.ok(!tacticalPlans(s, open, enemy, false).some(p => p.id === 'strafe_attack'));
});

test('cover and alternate angles require actual static routes and do not shoot through the obstacle', () => {
  const enemy = entity(1, 128, 0, 'enemy'), s = { ...initial, enemies: [enemy] };
  const coverMap = new DoomMap([{ ...wall(0, 40), a: { x: 40, y: 40 }, b: { x: 40, y: 200 } }]);
  const cover = tacticalPlans(s, coverMap, enemy, true).find(p => p.id === 'cover')!;
  assert.ok(cover); assert.equal(coverMap.sight(enemy.position, cover.steps.at(-1)!.target), 'solid-wall-blocked');
  assert.ok(!tacticalPlans(s, open, enemy, true).some(p => p.id === 'cover'));
  const blocked = new DoomMap([wall(0, 40)]);
  const p = tacticalPlans(s, blocked, undefined, true).find(p => p.id === 'reposition')!;
  assert.ok(p); assert.ok(p.steps.every(step => step.kind !== 'attack'));
  assert.equal(blocked.sight(p.steps.at(-1)!.target, enemy.position), 'unknown');
});

test('pickup memory expires, invalidates on maps or reliable absence, and survives truncated observations', () => {
  const s = { ...initial, pickups: [entity(54, 128)] }, memory = observePickups(s);
  assert.equal(memory.entries.length, 1);
  assert.equal(observePickups({ ...initial, map: 2 }, memory).entries.length, 0);
  assert.equal(observePickups(initial, memory).entries.length, 0);
  const far = { ...initial, x: 3000, tick: 70 };
  assert.equal(observePickups(far, memory).entries.length, 1);
  assert.equal(observePickups({ ...far, tick: s.tick + pickupMemoryPolicy.maxAgeTicks + 1 }, memory).entries.length, 0);
  const crowded = { ...initial, pickups: Array.from({ length: 16 }, (_, i) => entity(63, 10 + i)) };
  assert.ok(observePickups(crowded, memory).entries.some(p => p.engineType === 54));
  const copy = structuredClone(memory); copy.entries.length = 0; assert.equal(memory.entries.length, 1);
});

test('remembered resources produce navigation hints, not fabricated live targets', () => {
  const memory = observePickups({ ...initial, pickups: [entity(54, 256)] });
  const s = { ...initial, health: 40, tick: 70 };
  const p = rememberedPickupPlans(s, open, memory)[0]!;
  assert.ok(p); assert.match(p.evidence!, /availability must be rechecked/);
  assert.ok(p.steps.every(step => step.target.kind === 'point'));
  assert.equal(rememberedPickupPlans(initial, open, memory).length, 0);
});

test('expanded menu is bounded, unique, and preserves different goals before movement variants', () => {
  const enemy = entity(1, 128, 0, 'enemy');
  const s = { ...initial, health: 50, enemies: [enemy], pickups: [entity(54, 64), entity(47, 80), entity(69, 90), entity(77, 95)] };
  const plans = candidatePlans(s, open);
  assert.ok(plans.length <= doomPlanPolicy.maxCandidates);
  assert.equal(new Set(plans.map(p => p.id)).size, plans.length);
  for (const family of ['combat', 'health', 'resource', 'key', 'exploration']) assert.ok(plans.some(p => p.family === family));
  assert.ok(plans.some(p => p.id === 'strafe_attack'));
  assert.ok(plans.every(p => p.steps.length >= 2 && p.steps.length <= 3));
});
