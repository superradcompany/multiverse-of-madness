import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { Runtime, decision, initial } from '../test-support/fixture-runtime.ts';
import type { Step } from '../../../packages/contracts/src/game.ts';

test('intermission advances with release/press edges without model calls, controls or forks', async () => {
  let state = { ...structuredClone(initial), phase: 'intermission' as typeof initial.phase };
  let presses = 0, held = true, forks = 0;
  const commands: Step[] = [], runtime = new Runtime('intermission', state);
  runtime.branch = async () => { forks++; throw new Error('Must not branch results screens'); };
  runtime.step = async command => {
    commands.push(command);
    if (command.inputs.includes('fire') && !held) presses++;
    held = command.inputs.includes('fire');
    state = { ...state, tick: state.tick + command.ticks,
      ...(presses >= 2 ? { phase: 'level', map: 2 } : {}) };
    return structuredClone(state);
  };
  const session = new Session({ decide: async () => { throw new Error('No model decision needed'); } },
    { threshold: .75, horizon: 210, branches: 4, paceMs: 0 });
  session.setControls(async () => { throw new Error('Combat controls must not suppress continue'); });
  await session.initialize(runtime);
  try {
    session.step(); await session.idle(); const view = session.snapshot();
    assert.equal(view.error, undefined); assert.equal(view.worlds[0]!.state.map, 2);
    assert.equal(view.worlds[0]!.state.phase, 'level'); assert.equal(presses, 2); assert.equal(forks, 0);
    assert.ok(commands.length <= 35); assert.equal(commands[0]!.inputs.length, 0);
    assert.equal(view.stats!.kills, 0); assert.equal(view.decision, undefined);
  } finally { await session.close(); }
});

test('pause fences intermission inputs and an unfinished transition resumes without a model call', async () => {
  let state = { ...structuredClone(initial), phase: 'intermission' as const }, calls = 0;
  const runtime = new Runtime('paused-intermission', state);
  runtime.step = async command => { calls++; state = { ...state, tick: state.tick + command.ticks }; return state; };
  const session = new Session({ decide: async () => { throw new Error('No model decision needed'); } },
    { threshold: .75, horizon: 210, branches: 4, paceMs: 0 });
  await session.initialize(runtime);
  let paused: Promise<void> | undefined;
  session.setRecorder(async () => { if (calls === 3) paused = session.pause(); });
  try {
    session.resume(); await session.idle(); await paused; assert.equal(calls, 3);
    assert.equal(session.snapshot().error, undefined);
    session.setRecorder(async () => {}); session.step(); await session.idle();
    assert.equal(calls, 38, 'one bounded second per manual continuation');
  } finally { await session.close(); }
});

test('futures stop at a level exit instead of asking for combat decisions on the results screen', async () => {
  let modelCalls = 0;
  const source = new Runtime('exit-source');
  source.branch = async ids => ids.map(id => {
    const child = new Runtime(id); let tick = initial.tick;
    child.step = async command => { tick += command.ticks; return { ...structuredClone(initial), tick, phase: 'intermission' }; };
    return child;
  });
  const session = new Session({ decide: async () => { modelCalls++; return decision; } },
    { threshold: .75, horizon: 210, branches: 2, paceMs: 0, frameTicks: 7 });
  await session.initialize(source);
  try {
    session.step(); await session.idle(); const view = session.snapshot();
    assert.equal(view.error, undefined); assert.equal(modelCalls, 1);
    const futures = view.worlds.filter(world => world.role === 'experiment'); assert.equal(futures.length, 2);
    assert.ok(futures.every(world => world.state.phase === 'intermission' && world.state.tick === initial.tick + 7));
  } finally { await session.close(); }
});
