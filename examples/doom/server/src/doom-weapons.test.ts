import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomMap, geometryFor } from './doom-geometry.ts';
import { candidatePlans, planInputs, startPlan, weaponPlans } from './doom-plans.ts';
import { doomInputs } from './doom-controls.ts';
import { prepareDoomContext } from './doom-preparation.ts';
import { weaponHasAmmo, weaponInput } from './doom-weapons.ts';
import { initial } from '../test-support/fixture-runtime.ts';
import { SandboxGame } from './sandbox-game.ts';
import type { Sandbox } from 'microsandbox';
import type { GameState } from '../../contracts/src/game.ts';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { doomPreparationInput } from './doom-preparation-input.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';
import { resourcePlans } from './doom-tactics.ts';

const armed = (): GameState => ({ ...structuredClone(initial), weapon: 'fist', weapons: ['fist', 'pistol'], pendingWeapon: null, weaponSelection: true });
const map = new DoomMap([]);

test('equipment choices require observed capability, ownership and usable ammunition', () => {
  const s = armed();
  assert.equal(weaponPlans(s, map)[0]?.label, 'equip pistol');
  assert.deepEqual(weaponPlans({ ...s, weaponSelection: undefined }, map), []);
  assert.deepEqual(weaponPlans({ ...s, weapons: undefined }, map), []);
  assert.deepEqual(weaponPlans({ ...s, ammo: [0, 0, 0, 0] }, map), []);
  assert.equal(weaponInput({ ...s, weapons: ['fist', 'chainsaw'] }, 'fist'), undefined);
  assert.equal(weaponHasAmmo({ ...s, ammo: [0, 1, 39, 0] }, 'BFG'), false);
  assert.equal(weaponHasAmmo({ ...s, ammo: [0, 1, 39, 0] }, 'double shotgun'), false);
});

test('equip steps wait for observed completion and stop on missing capability or timeout', () => {
  const s = armed(), p = weaponPlans(s, map)[0]!, run = startPlan(p, s, 210);
  assert.deepEqual(planInputs(run, s, []), ['weapon2']);
  assert.deepEqual(planInputs(run, { ...s, tick: s.tick + 1, pendingWeapon: 'pistol' }, []), []);
  assert.equal(run.status, 'running');
  planInputs(run, { ...s, tick: s.tick + 35, weapon: 'pistol' }, []);
  assert.equal(run.status, 'complete');
  for (const update of [{ weaponSelection: undefined }, { weapons: [] }, { tick: s.tick + 105 }]) {
    const failed = startPlan(p, s, 210);
    assert.deepEqual(planInputs(failed, { ...s, ...update }, []), []);
    assert.equal(failed.status, 'replan');
  }
  assert.deepEqual(doomInputs(s, ['weapon2', 'fire'], map), ['weapon2']);
});

test('only preparation v3 can generate grounded equipment steps', () => {
  const state = armed(), p = weaponPlans(state, map)[0]!;
  const output = { abi: 'doom-preparation/3', plans: [p], historyIndices: [], experienceIndices: [], features: {} };
  const pool = { state, history: [], experience: [], experienceLimit: 0, planTicks: 210 };
  assert.equal(prepareDoomContext(output, pool).plans![0]!.steps[0]!.kind, 'equip');
  for (const abi of ['doom-preparation/1', 'doom-preparation/2']) assert.throws(() => prepareDoomContext({ ...output, abi }, pool));
  for (const update of [{ weaponSelection: undefined }, { weapons: [] }]) {
    assert.throws(() => prepareDoomContext(output, { ...pool, state: { ...state, ...update } }), /weapon selection/);
  }
  assert.throws(() => prepareDoomContext({ ...output, plans: [{ ...p, steps: [{ ...p.steps[0], weapon: 'BFG' }] }] }, pool), /weapon selection/);
});

test('preparation input keeps legacy default-plan copying valid alongside v3 equipment choices', async () => {
  const state = armed(), identity = contentRevision('weapon-fixture', {});
  const policy = new Session({ decide: async () => decision }).learningPolicy();
  const revision = { revision: identity, policy, prompts: {}, skills: [], executor: identity,
    adapter: { id: 'fixture', version: '1' }, model: { id: 'fixture', version: '1' } };
  const input = await doomPreparationInput(revision, state, 'survive', [], [], 35, { planTicks: 35 });
  const pool = { state, history: [], experience: [], experienceLimit: 0, planTicks: 35 };
  for (const abi of ['doom-preparation/1', 'doom-preparation/2']) {
    prepareDoomContext({ abi, historyIndices: [], experienceIndices: [], features: {}, plans: input.defaultPlans }, pool);
  }
  assert.ok(input.weaponPlans?.length);
  const prepared = prepareDoomContext({ abi: 'doom-preparation/3', historyIndices: [], experienceIndices: [], features: {}, plans: input.weaponPlans }, pool);
  assert.equal(prepared.plans![0]!.steps[0]!.maxTicks, 35, 'short user horizon still bounds switching');
  assert.deepEqual(input.feedback.weapons, ['fist', 'pistol']);
  assert.equal(input.feedback.weaponSelection, true);
});

test('observed ownership avoids sending an unequipped player to collect the same weapon', () => {
  const state = armed();
  state.pickups = [{ kind: 'pickup', engineType: 77, health: 0, distance: 64, relativeBearing: 0,
    heading: 0, direction: { x: 0, y: 0 }, towardPlayerAlignment: 0, position: { x: state.x + 64, y: state.y, z: state.z } }];
  state.angle = 0;
  assert.ok(resourcePlans(state, map).some(plan => plan.id === 'resource_77'));
  state.weapons!.push('shotgun');
  assert.equal(resourcePlans(state, map).find(plan => plan.id === 'resource_77')?.label, 'replenish ammunition');
  state.ammo[1] = 30;
  assert.ok(!resourcePlans(state, map).some(plan => plan.id === 'resource_77'));
});

test('legacy bridge refuses new controls before sending a step but still permits old controls', async () => {
  const game = new SandboxGame({} as Sandbox), requests: string[] = [];
  game.request = async path => { requests.push(path); return Buffer.from(JSON.stringify(initial)); };
  await assert.rejects(game.step({ ticks: 1, inputs: ['weapon2'] }), /unsupported/);
  assert.deepEqual(requests, ['/state']);
  await game.step({ ticks: 1, inputs: ['forward'] });
  assert.deepEqual(requests, ['/state', '/step']);
});

test('real WASM melee encounter switches to an owned pistol and kills the elevated target', async () => {
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  for (let i = 0; i < 105 && game.state().weapon !== 'fist'; i++) {
    game.step({ ticks: 1, inputs: game.state().pendingWeapon ? [] : ['weapon1'] });
  }
  for (let i = 0; i < 86; i++) game.step({ ticks: 1, inputs: ['forward'] });
  const before = game.state(), geometry = await geometryFor(before, true, true);
  assert.equal(before.weapon, 'fist');
  const plan = candidatePlans(before, geometry).find(p => p.id === 'equip_pistol');
  assert.ok(plan, 'ranged alternative must survive the candidate cap');
  assert.deepEqual(plan.steps.map(s => s.kind), ['equip', 'face', 'attack']);
  assert.ok(Math.abs(plan.steps.at(-1)!.target.z - before.z) > 56);
  const run = startPlan(plan, before, 210), history: GameState[] = [];
  let current = before;
  for (let i = 0; i < 210 && run.status === 'running'; i++) {
    let inputs = planInputs(run, current, history, geometry);
    if (run.status !== 'running') break;
    if (!inputs.every(input => input === 'left' || input === 'right')) inputs = doomInputs(current, inputs, geometry);
    history.push(current);
    current = game.step({ ticks: 1, inputs });
  }
  assert.equal(current.weapon, 'pistol');
  assert.ok(current.kills > before.kills, `expected a real kill; ${JSON.stringify({ before: before.kills, after: current.kills, status: run.status, reason: run.reason })}`);
});
