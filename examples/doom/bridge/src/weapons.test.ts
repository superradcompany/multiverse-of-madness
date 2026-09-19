import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from './engine.ts';
import type { Step } from '../../contracts/src/game.ts';

test('real WASM inventory and pending telemetry follow keyboard weapon switches', async () => {
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const initial = game.state();
  assert.deepEqual(initial.weapons, ['fist', 'pistol']);
  assert.equal(initial.weapon, 'pistol');
  assert.equal(initial.pendingWeapon, null);
  assert.equal(initial.weaponSelection, true);
  for (const [input, weapon] of [['weapon1', 'fist'], ['weapon2', 'pistol']] as const) {
    let current = game.step({ ticks: 1, inputs: [input] });
    for (let i = 0; i < 35 && !current.pendingWeapon; i++) current = game.step({ ticks: 1, inputs: [input] });
    assert.equal(current.pendingWeapon, weapon);
    for (let i = 0; i < 105 && (current.weapon !== weapon || current.pendingWeapon); i++) {
      current = game.step({ ticks: 1, inputs: [] });
    }
    assert.equal(current.weapon, weapon);
    assert.equal(current.pendingWeapon, null);
    assert.deepEqual(current.ammo, initial.ammo, 'selection does not fire');
    assert.deepEqual(current.weapons, initial.weapons, 'selection does not grant equipment');
  }
  const before = game.state();
  assert.throws(() => game.step({ ticks: 1, inputs: ['forward', 'not-a-key'] } as unknown as Step));
  assert.deepEqual(game.state(), before, 'invalid input fails before advancing the engine');
});

test('prototype-only legacy upgrades do not advertise a new HTTP input capability', async () => {
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  // Old instances do not have the field introduced by the new constructor.
  Reflect.deleteProperty(game, 'acceptsWeaponInputs');
  assert.equal(game.state().weaponSelection, undefined);
  assert.deepEqual(game.state().weapons, ['fist', 'pistol']);
});
