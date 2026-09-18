import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceDoomTemporaryGoal, proposeDoomTemporaryGoal, type DoomGoalContext, type DoomGoalProposal } from './doom-temporary-goal.ts';
import { initial } from '../test-support/fixture-runtime.ts';

const frame = { scope: { id: 'run', version: 'E1M1' }, context: { id: 'user', version: '1' }, source: { id: 'strategy', version: '1' }, clock: { unit: 'doom-ticks', value: initial.tick } };
const proposal: DoomGoalProposal = { key: 'escape', instruction: 'Reach the opening', reason: 'Repeated attempts made no progress', evidence: ['current-state'], duration: 70, target: { kind: 'position', x: 100, y: 0, z: 0, within: 8 } };
const context = (): DoomGoalContext => ({ frame: structuredClone(frame) });

test('Doom goals are bounded, branch-local and assessed from engine observations', () => {
  const parent = proposeDoomTemporaryGoal(proposal, context(), initial)!;
  const later = { ...frame, clock: { ...frame.clock, value: initial.tick + 35 } };
  const completed = advanceDoomTemporaryGoal(parent, later, { ...initial, x: 100 });
  assert.equal(completed.record.status, 'completed'); assert.equal(parent.record.status, 'active');
  assert.equal(advanceDoomTemporaryGoal(parent, later, { ...initial, x: 100, z: 100 }).record.status, 'active');
  const same = proposeDoomTemporaryGoal({ ...proposal, duration: 140 }, { frame: later, current: parent }, initial)!;
  assert.equal(same.record.id, parent.record.id); assert.equal(same.record.expiresAt, initial.tick + 70);
  const deadline = { ...frame, clock: { ...frame.clock, value: initial.tick + 70 } };
  const expired = advanceDoomTemporaryGoal(parent, deadline, { ...initial, x: 100 });
  assert.equal(expired.record.status, 'expired');
  assert.equal(proposeDoomTemporaryGoal(proposal, { frame: deadline, current: expired }, initial)!.record.status, 'expired');
  assert.equal(advanceDoomTemporaryGoal(parent, later, { ...initial, alive: false }).record.status, 'failed');
});
test('Doom goals reject unsupported targets and invalidate changed user/strategy/map identities', () => {
  const goal = proposeDoomTemporaryGoal(proposal, context(), initial)!;
  for (const key of ['context', 'source', 'scope'] as const) assert.equal(advanceDoomTemporaryGoal(goal, { ...frame, [key]: { ...frame[key], version: '2' } }, initial).record.status, 'invalidated');
  assert.throws(() => proposeDoomTemporaryGoal(proposal, undefined, initial), /host-owned/);
  assert.throws(() => proposeDoomTemporaryGoal({ ...proposal, target: { kind: 'position', x: 5000, y: 0, z: 0, within: 8 } }, context(), initial), /planning radius/);
  assert.equal(proposeDoomTemporaryGoal({ ...proposal, target: { kind: 'key', color: 'red' } }, context(), initial)!.record.status, 'failed');
  assert.equal(proposeDoomTemporaryGoal({ ...proposal, target: { kind: 'key', color: 'blue' } }, context(), { ...initial, keys: ['blue'] })!.record.status, 'completed');
});
