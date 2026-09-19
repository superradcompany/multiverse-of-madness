import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { Session } from '../examples/doom/server/src/session.ts';
import { createWorld } from '../examples/doom/server/src/runtime.ts';
import { candidatePlans } from '../examples/doom/server/src/doom-plans.ts';
import { geometryFor } from '../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../examples/doom/server/src/doom-navigation.ts';
import { decision } from '../examples/doom/server/test-support/fixture-runtime.ts';

// Real VMs and game inputs; scripted judgments isolate candidate execution.
// This proves the new attack is executable, not a Jev win-rate improvement.
const directory = await mkdtemp(join(tmpdir(), 'mom-combat-targeting-'));
const ids = new Set<string>();
const world = await createWorld(`mom-combat-targeting-${randomUUID()}`); ids.add(world.id);
let session: Session | undefined;
try {
  for (let tick = 0; tick < 86; tick++) await world.step({ ticks: 1, inputs: ['forward'] });
  const initial = await world.state(), map = await geometryFor(initial, true, true);
  const available = candidatePlans(initial, map), attack = available.find(plan => plan.id === 'engage');
  const explore = available.find(plan => plan.family === 'exploration');
  assert.ok(attack); assert.ok(explore);
  assert.ok(Math.abs(attack.steps[0]!.target.z - initial.z) > 56);
  let judgments = 0;
  session = new Session({ decide: async () => {
    judgments++;
    // Freeze after the initial bounded plans, so each branch measures only
    // that opening rather than introducing another scripted tactical choice.
    if (judgments > 1) return { ...decision, action: 'wait', confidence: 1, probabilities: { ...decision.probabilities, advance: 0, wait: 1 } };
    return { ...decision, confidence: .5, priority: 'combat', model: 'mechanical-combat-fixture',
      plans: { selected: attack.id, candidates: [{ ...attack, probability: .5 }, { ...explore, probability: .5 }] } };
  } }, { threshold: .75, horizon: 210, branches: 2, paceMs: 0, frameTicks: 7 });
  session.setControls(async (state, inputs, memory, policy) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), memory, policy));
  await session.initialize(world); session.setPlanningMode('plans'); session.setDecisionInterval(210);
  session.step(); await session.idle();
  const view = session.snapshot(); for (const item of view.worlds) ids.add(item.id);
  assert.equal(view.error, undefined);
  const trials = view.worlds.filter(item => item.role === 'experiment'); assert.equal(trials.length, 2);
  const attacked = trials.find(item => item.label === attack.label); assert.ok(attacked);
  assert.ok(attacked.state.kills > initial.kills, 'the elevated target must actually be killed');
  const result = { initial, previouslyExcludedHeight: Math.abs(attack.steps[0]!.target.z - initial.z), attack,
    qualification: 'Real branching execution with scripted choices, not a model or historical-policy comparison',
    trials: trials.map(item => ({ label: item.label, tick: item.state.tick, kills: item.state.kills - initial.kills,
      health: item.state.health, ammo: item.state.ammo, plan: item.plan })) };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  for (const item of trials) await writeFile(join(directory, item.label === attack.label ? 'attack.png' : 'explore.png'), session.frame(item.id));
  console.log(JSON.stringify({ directory, trials: result.trials }));
} finally {
  if (session) {
    for (const item of session.snapshot().worlds) ids.add(item.id);
    await session.close();
  } else await world.destroy();
  for (const id of ids) await assert.rejects(Sandbox.get(id), SandboxNotFoundError);
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ allVmsAbsent: [...ids] }, null, 2));
}
