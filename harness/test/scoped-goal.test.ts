import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedGoal, advanceScopedGoal, decodeScopedGoal, type GoalFrame, type GoalDraft, type ScopedGoalRules } from '../src/scoped-goal.ts';
import { JsonFileStore } from '../src/node/json-store.ts';

const rules: ScopedGoalRules<{ area: string }> = {
  version: { id: 'test-area-target', version: '1' }, maxDuration: 30,
  hasEvidence: reference => reference === 'observed-exit-1',
  parseTarget(value) {
    if (!value || typeof value !== 'object' || Object.keys(value).join() !== 'area'
      || !('area' in value) || typeof value.area !== 'string' || !value.area.trim()) throw new Error('Invalid area target');
    return { area: value.area };
  },
};
const frame = (value = 40): GoalFrame => ({
  scope: { id: 'run-a', version: 'scene-1' }, context: { id: 'user-objective', version: '1' },
  source: { id: 'planner', version: 'activation-2' }, clock: { unit: 'turns', value },
});
const draft = (): GoalDraft<{ area: string }> => ({ instruction: 'Reach the observed passage', reason: 'Repeated visits without progress',
  evidence: ['observed-exit-1'], duration: 10, target: { area: 'passage' } });
const goal = () => createScopedGoal('goal-1', draft(), frame(), rules);
const assess = (target: { area: string }, current: { area: string }) => ({
  status: target.area === current.area ? 'completed' as const : 'active' as const, reason: 'Observed player area',
});

test('scope and simulation time govern expiry without changing the user objective or renewing on a check', () => {
  const saved = goal(), current = frame(49), original = structuredClone(saved);
  const pending = advanceScopedGoal(saved, current, { area: 'room' }, rules, assess);
  assert.equal(pending.status, 'active'); assert.equal(pending.expiresAt, 50);
  assert.deepEqual(saved, original); assert.deepEqual(current, frame(49));
  const expired = advanceScopedGoal(pending, frame(50), { area: 'passage' }, rules, () => { throw new Error('Too late to grade success'); });
  assert.equal(expired.status, 'expired');
  assert.deepEqual(expired.created.context, frame().context);
  assert.deepEqual(advanceScopedGoal(expired, frame(45), { area: 'passage' }, rules, assess), expired);
});

test('forks inherit a goal but measured outcomes stay branch-local and terminal outcomes do not resurrect', () => {
  const source = goal(), left = structuredClone(source), right = structuredClone(source);
  const completed = advanceScopedGoal(left, frame(41), { area: 'passage' }, rules, assess);
  const pending = advanceScopedGoal(right, frame(41), { area: 'room' }, rules, assess);
  assert.equal(completed.status, 'completed'); assert.equal(pending.status, 'active');
  assert.equal(source.status, 'active');
  assert.deepEqual(advanceScopedGoal(completed, frame(42), { area: 'room' }, rules, assess), completed);
  const failed = advanceScopedGoal(pending, frame(42), {}, rules, () => ({ status: 'failed', reason: 'Observed route closed' }));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(advanceScopedGoal(failed, frame(43), {}, rules, () => { throw new Error('Terminal'); }), failed);
});

test('a different run, scene, objective, activation, clock unit or clock rewind invalidates before assessment', () => {
  const mutations: Array<(current: GoalFrame) => void> = [
    current => { current.scope.id = 'new-run'; }, current => { current.scope.version = 'scene-2'; },
    current => { current.context.version = '2'; }, current => { current.source.version = 'activation-3'; },
    current => { current.clock.unit = 'ticks'; }, current => { current.clock.value = 39; },
  ];
  for (const mutate of mutations) {
    const current = frame(42); mutate(current);
    const result = advanceScopedGoal(goal(), current, {}, rules, () => { throw new Error('Stale facts cannot grade goals'); });
    assert.equal(result.status, 'invalidated');
  }
  const checked = advanceScopedGoal(goal(), frame(48), { area: 'room' }, rules, assess);
  assert.equal(advanceScopedGoal(checked, frame(47), {}, rules, () => { throw new Error('Rewound'); }).status, 'invalidated');
});

test('persisted goals reopen with their original deadline and schema, even after source evidence is collected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scoped-goal-'));
  try {
    const path = join(directory, 'goal.json');
    await new JsonFileStore(path, value => decodeScopedGoal(value, rules)).save(goal());
    const resumed = await new JsonFileStore(path, value => decodeScopedGoal(value, { ...rules, hasEvidence: () => false })).load();
    assert.ok(resumed); assert.equal(resumed.expiresAt, 50);
    assert.equal(advanceScopedGoal(resumed, frame(50), {}, rules, () => { throw new Error('Expired'); }).status, 'expired');
    assert.throws(() => decodeScopedGoal(resumed, { ...rules, version: { id: 'other-game', version: '1' } }), /rules do not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('untrusted proposals cannot assign host scope, omit evidence, exceed lifetime or smuggle unsupported target fields', () => {
  const cases: unknown[] = [
    { ...draft(), scope: frame().scope }, { ...draft(), evidence: [] }, { ...draft(), evidence: ['invented'] },
    { ...draft(), evidence: ['observed-exit-1', 'observed-exit-1'] }, { ...draft(), target: { area: 'passage', secret: 'x' } },
    ...[0, -1, 31, Infinity, NaN].map(duration => ({ ...draft(), duration })),
  ];
  for (const value of cases) assert.throws(() => createScopedGoal('goal', value as ReturnType<typeof draft>, frame(), rules));
  let read = false;
  assert.throws(() => createScopedGoal('goal', { ...draft(), get duration() { read = true; return 5; } }, frame(), rules));
  assert.equal(read, false);
  assert.throws(() => createScopedGoal('goal', { ...draft(), duration: 1 }, frame(Number.MAX_VALUE), rules), /expiry/);
  assert.throws(() => createScopedGoal('goal', draft(), frame(), { ...rules, parseTarget: () => ({ area: 'rewritten' }) }), /silently rewriting/);
});

test('malformed persisted outcomes and unsupported formats are refused', () => {
  for (const change of [
    { format: 2 }, { expiresAt: 5000 }, { status: 'invented' },
    { checked: frame(55) }, { status: 'expired', outcome: 'early' },
    { status: 'completed', checked: frame(55), outcome: 'too late' },
    { status: 'failed', outcome: '' },
  ]) assert.throws(() => decodeScopedGoal({ ...goal(), ...change }, rules));
  assert.throws(() => advanceScopedGoal(goal(), frame(41), {}, rules, () => ({ status: 'active', reason: '' })));
});
