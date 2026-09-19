import './runtime-env.ts';
import assert from 'node:assert/strict';
import { createWorld, type WorldRuntime } from '../examples/doom/server/src/runtime.ts';
import { Session } from '../examples/doom/server/src/session.ts';
import { actions, type DecisionMaker, type Decision } from '../examples/doom/server/src/jev.ts';
import { candidatePlans } from '../examples/doom/server/src/doom-plans.ts';
import { geometryFor } from '../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../examples/doom/server/src/doom-navigation.ts';

// Real detached VMs and live game inputs; deterministic candidate selection.
// This checks execution/fork isolation, not Jev quality or a higher win rate.
const maker: DecisionMaker = { async decide(state, _guide, _history, _signal, _experience, _ticks, context) {
  const available = candidatePlans(state, await geometryFor(state, true, true), context?.visited, context?.pickups);
  assert.ok(available.length >= 2);
  return { action: 'advance', probabilities: Object.fromEntries(Object.keys(actions).map(id => [id, 1 / 8])) as Decision['probabilities'],
    confidence: 0, priority: 'exploration', latencyMs: 0, model: 'deterministic-smoke',
    plans: { selected: available[0]!.id, candidates: available.map(p => ({ ...p, probability: 1 / available.length })) } };
} };
const source = await createWorld(`mom-tactical-smoke-${Date.now()}`);
const branches: WorldRuntime[] = [];
const branch = source.branch.bind(source);
source.branch = async ids => { const children = await branch(ids); branches.push(...children); return children; };
const session = new Session(maker, { threshold: .75, horizon: 70, branches: 2, paceMs: 0 });
session.setControls(async (state, inputs, memory, policy) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), memory, policy));
try {
  const baseline = await source.state();
  await session.initialize(source);
  session.step(); await session.idle();
  const view = session.snapshot(); assert.equal(view.error, undefined); assert.equal(view.stage, 'choosing');
  const trials = view.worlds.filter(w => w.role === 'experiment'); assert.equal(trials.length, 2);
  for (const trial of trials) { assert.equal(trial.state.tick, baseline.tick + 70); assert.ok(trial.plan); }
  assert.deepEqual(await source.state(), baseline);
  const saved = session.checkpoint();
  assert.ok(saved.worlds.every(w => w.pickups));
  // Different goals may share the same opening path. Explicitly steer one
  // paused child and verify that neither its sibling nor source changes.
  const sibling = await branches[1]!.state();
  await session.takeover(trials[0]!.id); await session.input(trials[0]!.id, ['left']);
  assert.notDeepEqual(await branches[0]!.state(), sibling);
  assert.deepEqual(await branches[1]!.state(), sibling);
  assert.deepEqual(await source.state(), baseline);
  console.log(JSON.stringify({ realVmForks: true, sourceUnchanged: true, gameTicksPerFuture: 70, model: 'deterministic-smoke', plans: trials.map(w => w.plan?.label), pickupMemorySaved: true }));
} finally { await session.close(); }
