import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../../packages/game-bridge/src/engine.ts';
import { groundedState } from './doom-context.ts';

test('grounded context names engine resources and preserves unknown visibility', async () => {
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const state = engine.state();
  assert.equal(state.weapon, 'pistol');
  const entity = { kind: 'pickup' as const, engineType: 54, health: 1000, distance: 80, relativeBearing: -45, heading: 0, towardPlayerAlignment: 0, direction: { x: 1, y: 0 }, position: { x: state.x + 50, y: state.y - 50, z: state.z + 32 } };
  const context = groundedState({ ...state, pickups: [entity] }, 'survive', [], [], 70);
  assert.equal(context.secondsHoldingAction, 2);
  assert.equal(context.player.ammo.bullets, state.ammo[0]);
  assert.equal(context.pickups[0]?.kind, 'health +25 (up to 100)');
  assert.equal(context.pickups[0]?.leftDegrees, -45);
  assert.equal(context.pickups[0]?.heightDifference, 32);
  assert.match(context.limits, /NOT line of sight/);
  assert.equal(context.recent, null);
  const { weapon, ...oldState } = state;
  assert.equal(groundedState(oldState, 'survive', []).player.weapon, 'unknown');
});

test('grounded context uses prior observations only and stays within state budget', async () => {
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const before = engine.state(), after = engine.step({ ticks: 35, inputs: ['forward'] });
  const context = groundedState(after, 'x'.repeat(1000), [before, after]);
  assert.equal(context.recent?.seconds, 1);
  assert.ok(context.recent!.moved > 0);
  assert.ok(JSON.stringify(context).length < 5000);
});
