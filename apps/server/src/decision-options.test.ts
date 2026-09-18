import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionOptionsView } from './decision-options.ts';
import { decision } from '../test-support/fixture-runtime.ts';
const plan = (id: string, label: string) => ({ id, label, probability: .5, steps: [{ kind: 'face' as const, label: 'face the route', maxTicks: 35, target: { kind: 'point' as const, x: 10, y: 10, z: 0 } }] });
test('actual candidate options and selected plan are exposed, including additions and removals', () => {
  const first = decisionOptionsView({ ...decision, plans: { selected: 'left', candidates: [plan('left', 'go left'), plan('right', 'go right')] } }, 35);
  assert.equal(first.selected, 'left'); assert.deepEqual(first.options[0]!.steps, ['face the route']); assert.equal(first.changes, undefined);
  const next = decisionOptionsView({ ...decision, plans: { selected: 'cover', candidates: [plan('left', 'probe left'), plan('cover', 'seek cover')] } }, 70, first);
  assert.deepEqual(next.changes, { tick: 70, added: ['seek cover'], removed: ['go right'], updated: ['probe left'] });
  assert.equal(first.options[0]!.label, 'go left');
  const stable = decisionOptionsView({ ...decision, plans: { selected: 'left', candidates: [plan('left', 'probe left'), plan('cover', 'seek cover')] } }, 105, next);
  assert.deepEqual(stable.changes, next.changes, 'keep last actual menu change instead of flashing every decision');
});
test('action menus exclude actions removed from the actual judgment', () => {
  const view = decisionOptionsView({ ...decision, perception: { profile: 'game-aware', blockedEnemies: 0, uncertainTargets: 0, forwardBarrier: 0, movementFailed: false, excludedActions: ['advance'] } }, 35);
  assert.equal(view.kind, 'actions'); assert.ok(!view.options.some(option => option.id === 'advance'));
});
