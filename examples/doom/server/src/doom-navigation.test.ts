import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomMap, type Wall } from './doom-geometry.ts';
import { navigateDoomInputs, type NavigationMemory } from './doom-navigation.ts';

const wall = (x: number, start = -128, end = 128): Wall => ({ a: { x, y: start }, b: { x, y: end }, blocksSight: true, blocksMovement: true, special: 0 });
async function state() {
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  return { ...game.state(), x: 0, y: 0, z: 0, angle: 0, enemies: [], pickups: [] };
}

test('player footprint detects a wall endpoint missed by a center ray', async () => {
  const s = await state(), map = new DoomMap([wall(24, 10, 80)]);
  assert.equal(map.ray(s, 0), 512);
  assert.equal(map.clearance(s, 0), 8);
  const memory: NavigationMemory = {};
  const inputs = navigateDoomInputs(s, ['forward'], map, memory);
  assert.ok(!inputs.includes('forward'));
  assert.ok(inputs.includes('left') || inputs.includes('right'));
});

test('a recovery turn stays committed and target aiming cannot cancel it', async () => {
  const s = await state(), memory: NavigationMemory = {}, map = new DoomMap([wall(24)]);
  navigateDoomInputs(s, ['forward'], map, memory);
  const escape = structuredClone(memory.escape)!;
  const target = { kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 10, y: 0, z: 0 }, distance: 10, relativeBearing: 0, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 };
  const next = navigateDoomInputs({ ...s, tick: s.tick + 1, enemies: [target] }, ['forward'], map, memory);
  assert.deepEqual(memory.escape, escape);
  assert.deepEqual(next, [escape.turn]);
  const forward = navigateDoomInputs({ ...s, tick: s.tick + 2, angle: escape.heading }, ['forward'], map, memory);
  assert.ok(forward.includes('forward'));
});

test('unknown obstruction triggers recovery after seven failed ticks, and use pulses', async () => {
  const s = await state(), memory: NavigationMemory = {}, map = new DoomMap([]);
  const use: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    use.push(navigateDoomInputs({ ...s, tick: s.tick + i }, ['forward', 'use'], map, memory).includes('use'));
    assert.equal(memory.escape, undefined);
  }
  assert.equal(use.filter(Boolean).length, 1);
  assert.ok(navigateDoomInputs({ ...s, tick: s.tick + 7 }, ['forward', 'use'], map, memory).includes('left'));
  assert.ok(memory.escape);
});

test('intentional idle and discontinuous manual movement cancel recovery', async () => {
  const s = await state(), memory: NavigationMemory = {}, map = new DoomMap([wall(24)]);
  navigateDoomInputs(s, ['forward'], map, memory);
  assert.ok(memory.escape);
  assert.deepEqual(navigateDoomInputs({ ...s, tick: s.tick + 1 }, [], map, memory), []);
  assert.equal(memory.escape, undefined);
  navigateDoomInputs({ ...s, tick: s.tick + 2 }, ['forward'], map, memory);
  assert.ok(memory.escape);
  navigateDoomInputs({ ...s, tick: s.tick + 20, x: -200 }, ['forward'], map, memory);
  assert.equal(memory.escape, undefined);
});
