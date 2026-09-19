import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisorExampleHistory } from './supervisor-example-history.ts';
import type { GameState } from '../../contracts/src/game.ts';
import { initial } from '../test-support/fixture-runtime.ts';

test('supervisor examples remove exact duplicate observations with explicit counts, without changing live history', () => {
  const state = structuredClone(initial), before = { ...structuredClone(initial), tick: initial.tick - 1 };
  const history = [structuredClone(before), structuredClone(before), structuredClone(state)];
  const saved = structuredClone(history);
  const result = supervisorExampleHistory(state, history);
  assert.deepEqual(result.history, [before]);
  assert.equal(result.sampling.available, 3); assert.equal(result.sampling.window, 2);
  assert.equal(result.sampling.included, 1); assert.equal(result.sampling.repeatsCurrentState, 1);
  assert.match(result.sampling.scope, /Live history keeps its original entries and indices/);
  result.history[0]!.health--;
  assert.deepEqual(history, saved); assert.deepEqual(state, initial);
  const repeated = supervisorExampleHistory(state, [before, structuredClone(before)]);
  assert.equal(repeated.history.length, 1); assert.equal(repeated.sampling.repeatsEarlierEntry, 1);
  const empty = supervisorExampleHistory(state, [structuredClone(state), structuredClone(state)]);
  assert.equal(empty.history.length, 0); assert.equal(empty.sampling.repeatsCurrentState, 2);
});

test('unchanged position does not hide changed time, resources, threats or barriers', () => {
  const state = structuredClone(initial);
  const variants: GameState[] = [
    { ...state, tick: state.tick - 1 },
    { ...state, health: state.health - 1 },
    { ...state, ammo: state.ammo.map((amount, index) => index === 0 ? amount + 1 : amount) },
    { ...state, progressEvents: [{ kind: 'door', tick: state.tick, sector: 2, direction: 1 }] },
    { ...state, telemetry: { ...state.telemetry, engineObjectCount: state.telemetry.engineObjectCount + 1 } },
    { ...state, x: state.x + .001 },
  ];
  for (const changed of variants) {
    assert.notDeepEqual(changed, state, 'fixture must actually change an observation');
    assert.deepEqual(supervisorExampleHistory(state, [changed, state]).history, [changed]);
  }
});
