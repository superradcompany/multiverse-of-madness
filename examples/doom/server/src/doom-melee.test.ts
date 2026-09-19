import test from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../test-support/fixture-runtime.ts';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomMap, geometryFor } from './doom-geometry.ts';
import { doomInputs } from './doom-controls.ts';
import { candidatePlans, planInputs, startPlan, type GamePlan } from './doom-plans.ts';
import { failedPlanFeedback } from './plan-feedback.ts';
import { tacticalState, groundedState } from './doom-context.ts';
import type { GameState } from '../../contracts/src/game.ts';

const map = new DoomMap([]);
function encounter(distance: number, weapon = 'fist', height = 0): GameState {
  return { ...structuredClone(initial), weapon, enemies: [{ kind: 'enemy', engineType: 1, health: 20,
    position: { x: distance, y: 0, z: height }, distance, relativeBearing: 0, heading: 180,
    direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 }] };
}
function attack(state: GameState, kind: 'attack' | 'strafeAttack' = 'attack'): GamePlan {
  return { id: 'engage', label: 'engage', steps: [{ kind, direction: 'strafeLeft', label: 'attack', maxTicks: 140,
    target: { ...state.enemies[0]!.position, kind: 'enemy', engineType: 1 } }] };
}

test('distant melee targets cannot cancel requested movement or add ineffective fire', () => {
  for (const weapon of ['fist', 'chainsaw']) {
    const state = encounter(200, weapon);
    assert.deepEqual(doomInputs(state, ['left', 'forward'], map), ['left', 'forward']);
    assert.deepEqual(doomInputs(state, ['forward', 'fire'], map), ['forward']);
    assert.deepEqual(doomInputs(state, ['fire'], map), []);
    const plan = candidatePlans(state, map).find(plan => plan.id === 'engage')!;
    assert.deepEqual(plan.steps.map(step => step.kind), ['face', 'move', 'attack'], 'approaching remains a valid plan');
    assert.deepEqual(doomInputs(state, planInputs(startPlan(plan, state, 210), state, [], map), map), ['forward', 'use']);
  }
  assert.deepEqual(doomInputs(encounter(200, 'pistol'), ['left', 'forward'], map), ['fire'], 'ranged behavior is retained');
  assert.deepEqual(doomInputs({ ...encounter(200), weapon: undefined }, ['left', 'forward'], map), ['fire'], 'unknown legacy equipment is not classified as melee');
});

test('close melee attacks remain available while walls and height still constrain them', () => {
  for (const weapon of ['fist', 'chainsaw']) {
    assert.deepEqual(doomInputs(encounter(48, weapon), ['fire'], map), ['fire']);
    assert.deepEqual(doomInputs(encounter(80, weapon), ['fire'], map), ['fire'], 'known actor radius extends contact beyond its center');
    assert.deepEqual(doomInputs(encounter(84.01, weapon), ['fire'], map), []);
    assert.deepEqual(doomInputs(encounter(48, weapon, 80), ['fire'], map), []);
    const blocked = new DoomMap([{ a: { x: 24, y: -64 }, b: { x: 24, y: 64 }, blocksSight: true, blocksMovement: true, special: 0 }]);
    assert.deepEqual(doomInputs(encounter(48, weapon), ['fire'], blocked), []);
  }
});

test('large monster bodies remain melee candidates without treating unknown distant actors as reachable', () => {
  const state = encounter(150);
  state.enemies[0]!.engineType = 19;
  assert.deepEqual(doomInputs(state, ['fire'], map), ['fire'], 'spider radius is 128 units');
  const run = startPlan({ ...attack(state), steps: [{ ...attack(state).steps[0]!, target: { kind: 'enemy', ...state.enemies[0]!.position, engineType: 19 } }] }, state, 210);
  assert.deepEqual(planInputs(run, state, [], map), ['fire']);
  state.enemies[0]!.engineType = 999;
  assert.deepEqual(doomInputs(state, ['fire'], map), []);
});

test('a tracked enemy leaving melee reach requests replanning instead of using the full attack timeout', () => {
  for (const kind of ['attack', 'strafeAttack'] as const) {
    const state = encounter(40), run = startPlan(attack(state, kind), state, 210);
    assert.ok(planInputs(run, state, [], map).includes('fire'));
    const moved = { ...encounter(100), tick: state.tick + 1 };
    assert.deepEqual(planInputs(run, moved, [state], map), []);
    assert.equal(run.status, 'replan');
    assert.equal(run.reason, 'melee target out of reach');
    const feedback = failedPlanFeedback(run, moved);
    assert.equal(feedback?.reason, 'melee target out of reach');
    assert.equal(feedback?.target?.x, 100, 'supervisor receives the re-observed target');
    assert.equal(feedback?.ticksSinceStarted, 1);
  }
  const state = encounter(100, 'pistol'), run = startPlan(attack(state), state, 210);
  assert.deepEqual(planInputs(run, state, [], map), ['fire']);
  const changed = { ...state, weapon: 'fist', tick: state.tick + 1 };
  assert.deepEqual(planInputs(run, changed, [state], map), []);
  assert.equal(run.reason, 'melee target out of reach', 'automatic equipment changes are re-observed');
});

test('decision context distinguishes nearby enemies from those inside conservative melee reach', () => {
  for (const [distance, expected] of [[48, true], [200, false]] as const) {
    const state = encounter(distance);
    assert.equal(tacticalState(state, 'survive', [], map, 35).targetsNotBehindSolidWalls[0]!.withinMeleeReach, expected);
    assert.equal(groundedState(state, 'survive', [], [], 35, map).enemies[0]!.withinMeleeReach, expected);
  }
});

async function fists() {
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  for (let i = 0; i < 105 && engine.state().weapon !== 'fist'; i++) {
    engine.step({ ticks: 1, inputs: engine.state().pendingWeapon ? [] : ['weapon1'] });
  }
  assert.equal(engine.state().weapon, 'fist');
  return engine;
}

test('real WASM distant encounter preserves movement and close encounter still records a melee kill', async () => {
  const distant = await fists();
  for (let i = 0; i < 86; i++) distant.step({ ticks: 1, inputs: ['forward'] });
  const before = distant.state(), geometry = await geometryFor(before, true, true);
  assert.ok(before.enemies[0]!.distance > 400);
  const inputs = doomInputs(before, ['left', 'forward'], geometry);
  assert.deepEqual(inputs, ['left', 'forward']);
  const moved = distant.step({ ticks: 7, inputs });
  assert.notEqual(moved.angle, before.angle);
  assert.ok(Math.hypot(moved.x - before.x, moved.y - before.y) > 20);

  const engine = await fists();
  for (let i = 0; i < 143; i++) engine.step({ ticks: 1, inputs: ['forward'] });
  const close = engine.state(), map = await geometryFor(close, true, true);
  const plan = candidatePlans(close, map).find(plan => plan.id === 'engage');
  assert.ok(plan);
  const run = startPlan(plan, close, 210), history: GameState[] = [];
  let state = close;
  for (let i = 0; i < 210 && run.status === 'running'; i++) {
    const intent = planInputs(run, state, history, map);
    if (run.status !== 'running') break;
    const inputs = intent.every(input => input === 'left' || input === 'right') ? intent : doomInputs(state, intent, map);
    history.push(state); if (history.length > 10) history.shift();
    state = engine.step({ ticks: 1, inputs });
  }
  assert.equal(state.weapon, 'fist');
  assert.equal(state.kills - close.kills, 1);
  assert.equal(state.health, close.health);
  assert.equal(run.reason, 'target outcome observed');
});
