import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { Runtime, decision, initial } from '../test-support/fixture-runtime.ts';
import type { Input, Step } from '../../contracts/src/game.ts';
import type { PlanStep } from './doom-plans.ts';

for (const next of ['face', 'use', 'move'] as const) test(`arriving at a waypoint releases recovery before the next ${next} step`, async () => {
  const target = { kind: 'point' as const, x: 100, y: 0, z: 0 };
  const steps: PlanStep[] = [{ kind: 'move', target, label: 'approach', within: 16, maxTicks: 35 },
    { kind: next, target: { ...target, y: next === 'use' ? 0 : 100 }, label: 'next step', maxTicks: 35 }];
  const plan = { id: 'approach', label: 'approach then act', steps, probability: 1 };
  const session = new Session({ decide: async () => ({ ...decision, confidence: 1, plans: { selected: plan.id, candidates: [plan] } }) },
    { threshold: 0, horizon: 70, branches: 2, paceMs: 0 });
  const runtime = new Runtime('arrival-' + next);
  const commands: Step[] = [];
  runtime.step = async command => {
    commands.push(structuredClone(command));
    return { ...structuredClone(initial), tick: initial.tick + commands.length, x: 100 };
  };
  session.setControls(async (state, inputs, navigation) => {
    if (navigation.escape) return ['forward'];
    if (inputs.includes('forward')) navigation.escape = { heading: 180, turn: 'left', x: state.x, y: state.y, tick: state.tick };
    return inputs;
  });
  await session.initialize(runtime);
  let paused: Promise<void> | undefined;
  session.setRecorder(async () => { if (commands.length === 2) paused = session.pause(); });
  session.resume(); await session.idle(); await paused;
  assert.equal(session.snapshot().error, undefined);
  assert.deepEqual(commands[0]!.inputs, ['forward', 'use']);
  assert.deepEqual(commands[1]!.inputs, next === 'use' ? ['use'] : ['left']);
  assert.equal(session.checkpoint().worlds[0]!.navigation?.escape, undefined);
  await session.close();
});

test('recovery remains active while the original movement waypoint is still unreached', async () => {
  const plan = { id: 'route', label: 'follow route', probability: 1, steps: [{ kind: 'move' as const,
    target: { kind: 'point' as const, x: 1000, y: 0, z: 0 }, label: 'approach', maxTicks: 70 }] };
  const session = new Session({ decide: async () => ({ ...decision, confidence: 1, plans: { selected: plan.id, candidates: [plan] } }) },
    { threshold: 0, horizon: 70, branches: 2, paceMs: 0 });
  let calls = 0, reused = false;
  session.setControls(async (state, inputs, navigation): Promise<Input[]> => {
    calls++;
    if (calls === 2) reused = Boolean(navigation.escape);
    navigation.escape ??= { heading: 180, turn: 'left', x: state.x, y: state.y, tick: state.tick };
    return ['left'];
  });
  await session.initialize(new Runtime('ongoing-route'));
  let paused: Promise<void> | undefined;
  session.setRecorder(async () => { if (calls === 2) paused = session.pause(); });
  session.resume(); await session.idle(); await paused;
  assert.equal(session.snapshot().error, undefined); assert.equal(reused, true);
  await session.close();
});
