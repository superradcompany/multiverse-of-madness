import test from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../test-support/fixture-runtime.ts';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomMap, geometryFor } from './doom-geometry.ts';
import { candidatePlans, planInputs, startPlan, type GamePlan } from './doom-plans.ts';
import { doomInputs } from './doom-controls.ts';
import { defaultDoomMotorPolicy } from './doom-motor-policy.ts';
import type { GameState } from '../../contracts/src/game.ts';

function encounter(bearing: number): GameState {
  const radians = bearing * Math.PI / 180;
  return { ...structuredClone(initial), weapon: 'pistol', enemies: [{ kind: 'enemy', engineType: 1, health: 20,
    position: { x: 100 * Math.cos(radians), y: 100 * Math.sin(radians), z: 0 }, distance: 100,
    relativeBearing: bearing, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 }] };
}
function plan(state: GameState, kind: 'face' | 'attack' | 'strafeAttack'): GamePlan {
  return { id: 'engage', label: 'engage', steps: [{ kind, direction: 'strafeLeft', label: kind, maxTicks: 140,
    target: { ...state.enemies[0]!.position, kind: 'enemy', engineType: 1 } }] };
}

test('attack plans keep turning in the former 6-to-7-degree idle gap', () => {
  const state = encounter(6.5), map = new DoomMap([]);
  const inputs = planInputs(startPlan(plan(state, 'attack'), state, 210), state, [], map);
  assert.deepEqual(inputs, ['left']);
  assert.deepEqual(doomInputs(state, inputs, map), ['left']);
});

test('enemy facing, stationary and strafing attacks share the recorded motor tolerance', () => {
  const map = new DoomMap([]);
  for (const tolerance of [1, 3, 6, 12]) for (const sign of [-1, 1]) {
    const motor = { ...defaultDoomMotorPolicy, aimToleranceDegrees: tolerance };
    for (const kind of ['face', 'attack', 'strafeAttack'] as const) {
      const outside = encounter(sign * (tolerance + .5));
      const run = startPlan(plan(outside, kind), outside, 210);
      const inputs = planInputs(run, outside, [], map, undefined, motor);
      assert.ok(inputs.includes(sign > 0 ? 'left' : 'right'));
      assert.ok(!inputs.includes('fire'));
      assert.equal(run.status, 'running');
      const inside = encounter(sign * (tolerance - .5));
      const aligned = startPlan(plan(inside, kind), inside, 210);
      const intent = planInputs(aligned, inside, [], map, undefined, motor);
      if (kind === 'face') assert.equal(aligned.status, 'complete');
      else assert.ok(doomInputs(inside, intent, map, true, motor).includes('fire'));
    }
  }
});

test('local WASM combat no longer waits for the fire gate while its aim is outside tolerance', async () => {
  for (const aimToleranceDegrees of [6, 3]) {
    const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
    for (let i = 0; i < 86; i++) engine.step({ ticks: 1, inputs: ['forward'] });
    for (let i = 0; i < 7; i++) engine.step({ ticks: 1, inputs: ['left'] });
    const before = engine.state(), map = await geometryFor(before, true, true);
    const selected = candidatePlans(before, map).find(plan => plan.id === 'engage');
    assert.ok(selected);
    const run = startPlan(selected, before, 210), history: GameState[] = [];
    const motor = { ...defaultDoomMotorPolicy, aimToleranceDegrees };
    let state = before;
    for (let tick = 0; tick < 210 && run.status === 'running'; tick++) {
      const intent = planInputs(run, state, history, map, undefined, motor);
      if (run.status !== 'running') break;
      const inputs = intent.every(input => input === 'left' || input === 'right') ? intent : doomInputs(state, intent, map, true, motor);
      assert.ok(!intent.includes('fire') || inputs.length > 0, 'unblocked attack must not request a shot the motor refuses');
      history.push(state); if (history.length > 10) history.shift();
      state = engine.step({ ticks: 1, inputs });
    }
    assert.equal(state.kills - before.kills, 1);
    assert.equal(run.status, 'complete');
    assert.equal(state.health, before.health);
  }
});
