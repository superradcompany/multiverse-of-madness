import test from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../test-support/fixture-runtime.ts';
import { navigateDoomInputs, type NavigationMemory } from './doom-navigation.ts';
import { doomInputs } from './doom-controls.ts';
import { DoomMap } from './doom-geometry.ts';
import { defaultDoomMotorPolicy, doomMotorPolicySchema } from './doom-motor-policy.ts';
import { defaultDoomExecutionPolicy } from './doom-execution-policy.ts';

test('motor tuning changes observed-stall recovery and navigation use cadence', () => {
  const map = new DoomMap([]), memory: NavigationMemory = {}, old: NavigationMemory = {};
  const policy = { motor: { ...defaultDoomMotorPolicy, stalledTicks: 2 }, execution: { ...defaultDoomExecutionPolicy, usePulseTicks: 2 } };
  for (let tick = 0; tick < 2; tick++) {
    const state = { ...initial, tick };
    assert.deepEqual(navigateDoomInputs(state, ['forward', 'use'], map, memory, policy), tick ? ['forward'] : ['forward', 'use']);
    navigateDoomInputs(state, ['forward', 'use'], map, old);
  }
  assert.deepEqual(navigateDoomInputs({ ...initial, tick: 2 }, ['forward'], map, memory, policy), ['left']);
  assert.deepEqual(navigateDoomInputs({ ...initial, tick: 2 }, ['forward'], map, old), ['forward']);
  assert.ok(memory.escape); assert.equal(old.escape, undefined);
});

test('clearance and speed lookahead tuning remain grounded in the same player-footprint geometry', () => {
  const map = new DoomMap([{ a: { x: 40, y: -128 }, b: { x: 40, y: 128 }, blocksSight: true, blocksMovement: true, special: 0 }]);
  assert.deepEqual(navigateDoomInputs(initial, ['forward'], map, {}), ['forward']);
  const cautious = navigateDoomInputs(initial, ['forward'], map, {}, { motor: { ...defaultDoomMotorPolicy, minimumClearance: 32 } });
  assert.ok(!cautious.includes('forward'));
  const moving = { ...initial, velocity: { x: 2, y: 0, z: 0 } };
  assert.deepEqual(navigateDoomInputs(moving, ['forward'], map, {}), ['forward']);
  assert.ok(!navigateDoomInputs(moving, ['forward'], map, {}, { motor: { ...defaultDoomMotorPolicy, lookaheadTicks: 12 } }).includes('forward'));
});

test('escape distance and timeout affect recovery lifetime without leaking memory to siblings', () => {
  const map = new DoomMap([]), state = { ...initial, tick: 8, x: 20 };
  const original: NavigationMemory = { previous: { tick: 7, episode: 1, map: 1, x: 19, y: 0, translating: false },
    escape: { heading: 0, turn: 'left', x: 0, y: 0, tick: 0 } };
  const short = structuredClone(original), old = structuredClone(original);
  navigateDoomInputs(state, ['forward'], map, short, { motor: { ...defaultDoomMotorPolicy, escapeDistance: 16 } });
  navigateDoomInputs(state, ['forward'], map, old);
  assert.equal(short.escape, undefined); assert.deepEqual(old.escape, original.escape);
  const timed = structuredClone(original);
  navigateDoomInputs(state, ['forward'], map, timed, { motor: { ...defaultDoomMotorPolicy, escapeTicks: 7 } });
  assert.equal(timed.escape!.tick, 8); assert.equal(original.escape!.tick, 0);
});

test('desired route clearance changes the choice among observed recovery directions', () => {
  class Geometry extends DoomMap {
    override clearance(_point: { x: number; y: number }, heading: number) { return heading === 15 ? 64 : heading === 30 ? 128 : 0; }
  }
  const map = new Geometry([]), old: NavigationMemory = {}, tighter: NavigationMemory = {};
  navigateDoomInputs(initial, ['forward'], map, old);
  navigateDoomInputs(initial, ['forward'], map, tighter, { motor: { ...defaultDoomMotorPolicy, routeClearance: 32 } });
  assert.equal(old.escape!.heading, 30); assert.equal(tighter.escape!.heading, 15);
});

test('aim preferences change alignment and turn assistance but never permit blocked shots', () => {
  const enemy = { kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 100, y: 0, z: 0 }, distance: 100,
    relativeBearing: 9, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 };
  const state = { ...initial, enemies: [enemy] }, clear = new DoomMap([]);
  const motor = { ...defaultDoomMotorPolicy, aimToleranceDegrees: 12, turnToTargetDegrees: 100 };
  assert.deepEqual(doomInputs(state, ['fire'], clear), []);
  assert.deepEqual(doomInputs(state, ['fire'], clear, true, motor), ['fire']);
  const blocked = new DoomMap([{ a: { x: 50, y: -100 }, b: { x: 50, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 }]);
  assert.deepEqual(doomInputs(state, ['fire'], blocked, true, motor), []);
  const beside = { ...state, enemies: [{ ...enemy, relativeBearing: 90 }] };
  assert.deepEqual(doomInputs(beside, ['left', 'forward'], clear), ['left', 'forward']);
  assert.deepEqual(doomInputs(beside, ['left', 'forward'], clear, true, motor), ['left']);
  assert.deepEqual(doomInputs(state, [], clear, true, motor), []);
  for (const patch of [{ stalledTicks: 0 }, { lookaheadTicks: Infinity }, { aimToleranceDegrees: 180 }, { routeClearance: 0 }]) {
    assert.throws(() => doomMotorPolicySchema.parse({ ...motor, ...patch }));
  }
});
