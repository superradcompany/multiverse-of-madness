import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDoomContext } from './doom-preparation.ts';
import { initial } from '../test-support/fixture-runtime.ts';

const output = () => ({ abi: 'doom-preparation/1', historyIndices: [0], experienceIndices: [], features: { routeBlocked: false },
  plans: [{ id: 'new_route', label: 'Try another opening', steps: [{ kind: 'move', label: 'Move toward the opening', target: { kind: 'point', x: 96, y: 32, z: 0 }, maxTicks: 35 }] }] });
const pool = () => ({ state: structuredClone(initial), history: [structuredClone(initial)], experience: [], experienceLimit: 2, planTicks: 210, visited: [] });
test('preparation accepts newly generated plans but derives novelty and evidence from host observations', () => {
  const source = output(), input = pool(), prepared = prepareDoomContext(source, input);
  assert.equal(prepared.plans![0]!.id, 'new_route'); assert.equal(prepared.plans![0]!.novelty, 1);
  source.plans[0]!.steps[0]!.target.x = 999; input.history[0]!.health = 1;
  assert.equal(prepared.plans![0]!.steps[0]!.target.x, 96); assert.equal(prepared.history[0]!.health, 100);
});
test('preparation refuses forged actors, evidence indices, authority fields and actions outside user bounds', () => {
  for (const mutate of [
    (value: any) => { value.experienceIndices = [0]; },
    (value: any) => { value.historyIndices = [0, 0]; },
    (value: any) => { value.stats = { kills: 100 }; },
    (value: any) => { value.plans[0].steps[0].kind = 'teleport'; },
    (value: any) => { value.plans[0].steps[0].maxTicks = 211; },
    (value: any) => { value.plans[0].steps[0].target.x = 999999; },
    (value: any) => { value.plans[0].steps[0].target.kind = 'enemy'; value.plans[0].steps[0].target.engineType = 1; },
    (value: any) => { value.plans[0].steps[0].kind = 'attack'; },
    (value: any) => { value.plans.push(structuredClone(value.plans[0])); },
    (value: any) => { value.features = { text: 'x'.repeat(2000) }; },
  ]) { const value = output(); mutate(value); assert.throws(() => prepareDoomContext(value, pool())); }
  assert.throws(() => prepareDoomContext(output(), { ...pool(), planTicks: undefined }), /action-only/);
});
