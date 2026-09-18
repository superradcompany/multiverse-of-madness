import test from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../test-support/fixture-runtime.ts';
import { defaultDoomOutcomeWeights, doomOutcomeWeightsSchema, scoreDoomOutcome } from './doom-outcome.ts';

test('default search weights preserve historical scores across priorities and map transitions', () => {
  const outcomes = [initial, { ...initial, health: 0, alive: false },
    { ...initial, health: 72, kills: 3, items: 5, secrets: 1, ammo: [14, 8, 0, 0] },
    { ...initial, episode: 2, kills: 1, items: 2 }, { ...initial, phase: 'intermission' as const }];
  const expected = { survival: [12, -1000000, -560.8, 100072, 100012],
    exploration: [48, -1000000, 35.2, 100108, 100048], combat: [12, -1000000, 329.2, 100182, 100012] };
  for (const priority of ['survival', 'exploration', 'combat'] as const) outcomes.forEach((after, i) => {
    assert.ok(Math.abs(scoreDoomOutcome(initial, after, priority, 4) - expected[priority][i]!) < 1e-8);
  });
});

test('bounded shaped rewards can alter search preferences without changing observations or rewarding death', () => {
  const shaping = structuredClone(defaultDoomOutcomeWeights);
  const damaged = { ...initial, health: 80, kills: 1 };
  const healthy = { ...initial, x: 96 };
  assert.ok(scoreDoomOutcome(initial, damaged, 'combat') < scoreDoomOutcome(initial, healthy, 'combat'));
  shaping.combat.health = 1; shaping.combat.kills = 200;
  const parsed = doomOutcomeWeightsSchema.parse(shaping);
  assert.ok(scoreDoomOutcome(initial, damaged, 'combat', 0, parsed) > scoreDoomOutcome(initial, healthy, 'combat', 0, parsed));
  assert.equal(scoreDoomOutcome(initial, { ...damaged, alive: false }, 'combat', 0, parsed), -1000000);
  assert.equal(initial.health, 100); assert.equal(defaultDoomOutcomeWeights.combat.health, 10);
  assert.throws(() => doomOutcomeWeightsSchema.parse({ ...shaping, acceptanceMetric: 'kills' }));
  assert.throws(() => doomOutcomeWeightsSchema.parse({ ...shaping, combat: { ...shaping.combat, kills: Infinity } }));
  assert.throws(() => doomOutcomeWeightsSchema.parse({ ...shaping, combat: { ...shaping.combat, health: -1 } }));
});
