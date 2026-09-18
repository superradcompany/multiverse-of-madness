import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../../packages/game-bridge/src/engine.ts';
import { DoomMap, geometryFor } from './doom-geometry.ts';
import { doomInputs } from './doom-controls.ts';
import { candidatePlans, planInputs, startPlan, type GamePlan } from './doom-plans.ts';

async function state() { return { ...(await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state(), x: 0, y: 0, z: 0, angle: 0, enemies: [], pickups: [] }; }
const target = { kind: 'point' as const, x: 0, y: 128, z: 0 };
const plan: GamePlan = { id: 'explore', label: 'explore left', steps: [{ kind: 'face', label: 'face opening', target, maxTicks: 105 }, { kind: 'move', label: 'reach opening', target, within: 24, maxTicks: 140 }] };

test('plan steps advance on alignment and arrival, not a fixed action interval', async () => {
  const s = await state(), run = startPlan(plan, s, 210);
  assert.deepEqual(planInputs(run, s, []), ['left']);
  assert.deepEqual(planInputs(run, { ...s, tick: s.tick + 1, angle: 90 }, []), ['forward', 'use']);
  assert.equal(run.step, 1);
  assert.deepEqual(planInputs(run, { ...s, tick: s.tick + 2, angle: 90, y: 112 }, []), []);
  assert.equal(run.status, 'complete');
});

test('danger, step timeout, level change and comparison horizon terminate a plan', async () => {
  const s = await state();
  for (const [update, reason] of [[{ health: s.health - 8 }, 'taking damage'], [{ tick: s.tick + 105 }, 'step time limit reached'], [{ map: 2 }, 'game state changed'], [{ tick: s.tick + 210 }, 'comparison duration reached']] as const) {
    const run = startPlan(plan, s, 210); planInputs(run, { ...s, ...update }, []); assert.equal(run.reason, reason);
  }
});

test('a missing target requests another judgment instead of pursuing stale coordinates', async () => {
  const s = await state(), pickup = { ...target, kind: 'pickup' as const, engineType: 54 };
  const p: GamePlan = { id: 'health', label: 'collect health', steps: [{ ...plan.steps[0]!, target: pickup }, { ...plan.steps[1]!, target: pickup }] };
  const run = startPlan(p, s, 210); planInputs(run, s, []);
  assert.equal(run.status, 'replan'); assert.equal(run.reason, 'target lost or ambiguous');
});

test('candidate plans have bounded conditional steps and exclude health across walls', async () => {
  const s = await state();
  const plans = candidatePlans(s, new DoomMap([]));
  assert.ok(plans.length >= 2);
  assert.ok(plans.every(p => p.steps.length >= 2 && p.steps.length <= 3 && p.steps.every(step => step.maxTicks > 0)));
  const pickup = { kind: 'pickup' as const, engineType: 54, health: 1000, distance: 80, relativeBearing: 0, heading: 0, towardPlayerAlignment: 0, direction: { x: 0, y: 0 }, position: { x: 80, y: 0, z: 0 } };
  const hurt = { ...s, health: 50, pickups: [pickup] };
  assert.ok(candidatePlans(hurt, new DoomMap([])).some(p => p.id === 'recover'));
  const walls = new DoomMap([{ a: { x: 40, y: -100 }, b: { x: 40, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 }]);
  assert.ok(!candidatePlans(hurt, walls).some(p => p.id === 'recover'));
});

test('attack plans replan when the target becomes obstructed or ammunition runs out', async () => {
  const s = await state();
  const enemy = { kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 100, y: 0, z: 0 }, distance: 100, relativeBearing: 0, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 };
  const before = { ...s, enemies: [enemy] };
  const p = candidatePlans(before, new DoomMap([])).find(p => p.id === 'engage')!;
  assert.ok(p);
  const run = startPlan(p, before, 210);
  assert.deepEqual(planInputs(run, before, [], new DoomMap([])), ['fire']);
  planInputs(run, { ...before, tick: before.tick + 1, ammo: [0, 0, 0, 0] }, []);
  assert.equal(run.reason, 'weapon needs ammunition');
  const blocked = startPlan(p, before, 210);
  planInputs(blocked, before, [], new DoomMap([{ a: { x: 50, y: -100 }, b: { x: 50, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 }]));
  assert.equal(blocked.reason, 'target became obstructed');
});

test('ranged plans offer elevated targets accepted by the motor without chasing their floor', async () => {
  const s = await state();
  for (const z of [-96, 96]) {
    const enemy = { kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 256, y: 0, z },
      distance: 256, relativeBearing: 0, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 };
    const before = { ...s, weapon: 'pistol', ammo: [50, 0, 0, 0], enemies: [enemy] };
    const map = new DoomMap([]), plan = candidatePlans(before, map).find(p => p.id === 'engage');
    assert.ok(plan);
    assert.deepEqual(plan.steps.map(step => step.kind), ['face', 'attack']);
    const requested = planInputs(startPlan(plan, before, 210), before, [], map);
    assert.deepEqual(doomInputs(before, requested, map), ['fire']);
    assert.ok(!candidatePlans({ ...before, weapon: 'fist' }, map).some(p => p.id === 'engage'), 'melee cannot reach another floor');
    assert.ok(!candidatePlans({ ...before, ammo: [0, 0, 0, 0] }, map).some(p => p.id === 'engage'));
    const wall = { a: { x: 128, y: -100 }, b: { x: 128, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 };
    const blocked = new DoomMap([wall]);
    assert.ok(!candidatePlans(before, blocked).some(p => p.id === 'engage'));
    assert.deepEqual(doomInputs(before, ['fire'], blocked), []);
    const uncertain = new DoomMap([{ ...wall, blocksSight: false, front: { floor: 0, ceiling: 128, dynamic: true } }], true, true);
    assert.ok(!candidatePlans(before, uncertain).some(p => p.id === 'engage'), 'unknown moving openings are not proven firing angles');
    const steep = { ...before, enemies: [{ ...enemy, position: { ...enemy.position, z: 256 } }] };
    assert.ok(!candidatePlans(steep, map).some(p => p.id === 'engage'));
  }
});

test('real engine elevated opening encounter can be killed with the offered ranged plan', async () => {
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  // Reproduce by actual inputs, not position/health writes: the player is
  // descending toward the first room while the target is 76 units below.
  for (let tick = 0; tick < 86; tick++) engine.step({ ticks: 1, inputs: ['forward'] });
  const initial = engine.state(), map = await geometryFor(initial, true, true);
  const plan = candidatePlans(initial, map).find(p => p.id === 'engage');
  assert.ok(plan);
  assert.ok(Math.abs(plan.steps[0]!.target.z - initial.z) > 56, 'exercises the previously excluded height');
  const run = startPlan(plan, initial, 210), history: typeof initial[] = [];
  let current = initial;
  for (let tick = 0; tick < 210 && run.status === 'running'; tick++) {
    let inputs = planInputs(run, current, history, map);
    if (run.status !== 'running') break;
    if (!inputs.every(input => input === 'left' || input === 'right')) inputs = doomInputs(current, inputs, map);
    history.push(current); if (history.length > 12) history.shift();
    current = engine.step({ ticks: 1, inputs });
  }
  assert.equal(run.status, 'complete');
  assert.equal(run.reason, 'target outcome observed');
  assert.equal(current.kills - initial.kills, 1);
  assert.equal(current.health, initial.health);
  assert.ok(current.ammo[0]! < initial.ammo[0]!);
});

test('exploration prefers unseen destinations and can route through known space to a frontier', async () => {
  const { cell } = await import('./run-stats.ts');
  const { frontierRoute } = await import('./doom-plans.ts');
  const s = await state(), known = new Set<string>();
  for (let x = -256; x <= 256; x += 64) for (let y = -256; y <= 256; y += 64) known.add(cell({ ...s, x, y }));
  const route = frontierRoute(s, new DoomMap([]), known);
  assert.ok(route.length >= 1 && route.length <= 2);
  assert.ok(!known.has(cell({ ...s, ...route.at(-1)! })));
  const plans = candidatePlans(s, new DoomMap([]), [...known]);
  assert.ok(plans.some(p => p.id === 'frontier'));
  const familiar = [cell(s), cell({ ...s, x: 192 })];
  const fresh = candidatePlans(s, new DoomMap([]), familiar).filter(p => p.id.startsWith('explore_'));
  assert.ok(fresh.every(p => p.novelty === 1));
});

test('separate nearby enemies remain valid targets instead of excluding the entire group', async () => {
  const s = await state();
  const enemy = (y: number) => ({ kind: 'enemy' as const, engineType: 1, health: 20, position: { x: 100, y, z: 0 }, distance: Math.hypot(100, y), relativeBearing: 0, heading: 180, direction: { x: -1, y: 0 }, towardPlayerAlignment: 1 });
  const before = { ...s, enemies: [enemy(0), enemy(32)] };
  const p = candidatePlans(before, new DoomMap([])).find(p => p.id === 'engage')!;
  assert.ok(p); const run = startPlan(p, before, 210);
  assert.deepEqual(planInputs(run, before, [], new DoomMap([])), ['fire']);
});

test('interaction attempts use the engine reach instead of refusing valid 48-to-64 unit targets', async () => {
  const s = { ...(await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state(), x: 0, y: 0, angle: 0 };
  const make = (x: number) => startPlan({ id: 'use', label: 'use', steps: [{ kind: 'use', label: 'press use',
    target: { kind: 'point', x, y: 0, z: s.z }, maxTicks: 35 }] }, s, 210);
  for (const x of [54, 64]) {
    const run = make(x); assert.deepEqual(planInputs(run, s, []), ['use']); assert.equal(run.status, 'running');
  }
  const outside = make(64.01); assert.deepEqual(planInputs(outside, s, []), []);
  assert.equal(outside.reason, 'interaction out of reach');
});
