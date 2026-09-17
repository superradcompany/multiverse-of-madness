import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../../packages/game-bridge/src/engine.ts';
import { DoomMap } from './doom-geometry.ts';
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
