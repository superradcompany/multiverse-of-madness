import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomMap } from './doom-geometry.ts';
import { doomInputs } from './doom-controls.ts';

test('motor control suppresses blocked shots and stops turning on aligned targets', async () => {
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const state = { ...engine.state(), x: 0, y: 0, z: 0, angle: 0 };
  const target = { ...state.enemies[0]!, position: { x: 100, y: 0, z: 0 }, distance: 100, relativeBearing: 0 };
  state.enemies = [target];
  const clear = new DoomMap([]);
  const blocked = new DoomMap([{ a: { x: 50, y: -50 }, b: { x: 50, y: 50 }, blocksSight: true, blocksMovement: true, special: 0 }]);
  assert.deepEqual(doomInputs(state, ['fire'], blocked), []);
  assert.deepEqual(doomInputs(state, ['strafeLeft', 'fire'], blocked), ['strafeLeft']);
  assert.deepEqual(doomInputs(state, ['left', 'forward'], clear), ['fire']);
  assert.deepEqual(doomInputs(state, [], clear), [], 'intentional wait stays idle');
  state.enemies = [{ ...target, relativeBearing: 45 }];
  assert.deepEqual(doomInputs(state, ['left', 'forward'], clear), ['left']);
  assert.deepEqual(doomInputs(state, ['fire'], clear), [], 'enemy beside player is not in the firing direction');
  assert.deepEqual(doomInputs(state, ['backward', 'fire'], clear), ['backward']);
  state.enemies = [];
  assert.deepEqual(doomInputs(state, ['fire'], clear), []);
});
