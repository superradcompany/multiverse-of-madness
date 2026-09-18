import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { Runtime, decision, initial } from '../test-support/fixture-runtime.ts';
import type { GameState } from '../../contracts/src/game.ts';
import type { DecisionContext } from './jev.ts';

const nextPlan = (x: number) => ({ ...structuredClone(decision), confidence: 1, plans: { selected: 'route', candidates: [{
  id: 'route', label: 'explore route', probability: 1, steps: [{ kind: 'move' as const, label: 'move along route',
    target: { kind: 'point' as const, x, y: 0, z: 0 }, maxTicks: 70 }],
}] } });

test('Jev plans during real session advancement and a fresh result avoids another request at the boundary', async () => {
  const calls: Array<{ state: GameState; context?: DecisionContext }> = [];
  let finish!: () => void, advanced!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const done = new Promise<void>(resolve => { advanced = resolve; });
  const session = new Session({ decide: async (state, _goal, _history, signal, _experience, _ticks, context) => {
    calls.push({ state: structuredClone(state), context: structuredClone(context) });
    if (calls.length === 2) { await response; signal.throwIfAborted(); }
    return nextPlan(calls.length === 1 ? 100 : 200);
  } }, { threshold: 0, branches: 2, horizon: 70, paceMs: 0 });
  await session.initialize(new Runtime('prefetch'));
  session.setPlanningMode('plans'); session.setDecisionInterval(35);
  let paused: Promise<void> | undefined;
  session.setRecorder(async world => {
    if (world.state.tick >= initial.tick + 30) finish();
    if (world.state.tick >= initial.tick + 36 && !paused) { paused = session.pause(); advanced(); }
  });
  session.resume();
  try {
    await done;
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.state.tick, initial.tick + 7);
    assert.equal(calls[1]!.context?.stats?.current.tick, initial.tick + 7);
    assert.equal(calls[1]!.context?.planningAhead?.remainingTicks, 28);
    assert.equal(session.snapshot().decision?.prefetched, true);
    assert.equal(session.snapshot().decision?.tick, initial.tick + 35);
  } finally { finish(); await session.pause(); await paused; }
  assert.equal(session.snapshot().error, undefined);
});

for (const change of ['goal', 'skills', 'damage'] as const) test(`prefetch is discarded after ${change}; the next request captures updated facts`, async () => {
  const calls: Array<{ state: GameState; goal: string; context?: DecisionContext }> = [];
  let finish!: () => void, advanced!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const done = new Promise<void>(resolve => { advanced = resolve; });
  const runtime = new Runtime('stale-' + change);
  const step = runtime.step.bind(runtime);
  runtime.step = async command => {
    const state = await step(command);
    return change === 'damage' && state.tick >= initial.tick + 20 ? { ...state, health: 99 } : state;
  };
  const session = new Session({ decide: async (state, goal, _history, signal, _experience, _ticks, context) => {
    calls.push({ state: structuredClone(state), goal, context: structuredClone(context) });
    if (calls.length === 2) { await response; signal.throwIfAborted(); }
    return nextPlan(calls.length === 1 ? 100 : 200);
  } }, { threshold: 0, branches: 2, horizon: 70, paceMs: 0 });
  await session.initialize(runtime); session.setPlanningMode('plans'); session.setDecisionInterval(35);
  let changed = false, paused: Promise<void> | undefined;
  session.setRecorder(async world => {
    if (!changed && world.state.tick >= initial.tick + 20) {
      changed = true;
      if (change === 'goal') session.queueObjective('Conserve ammo');
      if (change === 'skills') session.saveSkill({ name: 'New skill', instructions: 'Keep moving toward unexplored areas', enabled: true });
      finish();
    }
    if (calls.length >= 3 && !paused) { paused = session.pause(); advanced(); }
  });
  session.resume();
  try {
    await done;
    assert.equal(session.snapshot().decision?.prefetched, false);
    assert.equal(calls[2]!.context?.planningAhead, undefined);
    if (change === 'goal') assert.equal(calls[2]!.goal, 'Conserve ammo');
    if (change === 'skills') assert.equal(calls[2]!.context?.skills?.[0]?.name, 'New skill');
    if (change === 'damage') assert.equal(calls[2]!.context?.stats?.current.health, 99);
  } finally { finish(); await session.pause(); await paused; }
  assert.equal(session.snapshot().error, undefined);
});

test('a prepared goal that expires during prefetch cannot authorize the next plan', async () => {
  const { proposeDoomTemporaryGoal } = await import('./doom-temporary-goal.ts');
  let calls = 0, finish!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const session = new Session({ decide: async (state, _objective, _history, signal, _experience, _ticks, context) => {
    calls++;
    const value = nextPlan(calls === 1 ? 100 : 200);
    if (calls === 2) {
      value.temporaryGoal = proposeDoomTemporaryGoal({ key: 'short', instruction: 'Reach another opening', reason: 'Try a bounded detour',
        evidence: ['current-state'], duration: 10, target: { kind: 'position', x: 200, y: 0, z: 0, within: 8 } }, context?.temporaryGoal, state);
      await response; signal.throwIfAborted();
    }
    return value;
  } }, { threshold: 0, branches: 2, horizon: 70, paceMs: 0 });
  await session.initialize(new Runtime('goal-prefetch')); session.setPlanningMode('plans'); session.setDecisionInterval(35);
  let paused: Promise<void> | undefined;
  session.setRecorder(async world => {
    if (world.state.tick >= initial.tick + 30) finish();
    if (calls >= 3) paused ??= session.pause();
  });
  try {
    session.resume(); await session.idle(); await paused;
    assert.equal(calls, 3);
    assert.equal(session.snapshot().decision?.prefetched, false);
    assert.equal(session.snapshot().worlds[0]!.temporaryGoal, undefined);
    assert.equal(session.snapshot().error, undefined);
  } finally { finish(); await session.close(); }
});
