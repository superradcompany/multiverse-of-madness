import { reachableRoute } from './doom-route.ts';
import type { PickupMemory } from './doom-pickup-memory.ts';
import { interactionPlans, resourcePlans, tacticalPlans, rememberedPickupPlans } from './doom-tactics.ts';
import { doomPlanPolicy, type PlanFamily } from './doom-plan-policy.ts';
import { cell } from './run-stats.ts';
import { weaponHasAmmo, weaponInput } from './doom-weapons.ts';
import type { GameState, Input, Weapon } from '../../contracts/src/game.ts';
import type { PlanView } from '../../contracts/src/session.ts';
import type { DoomMap } from './doom-geometry.ts';
import { plausibleRangedTarget } from './doom-targeting.ts';
import { defaultDoomMotorPolicy, type DoomMotorPolicy } from './doom-motor-policy.ts';
import { defaultDoomExecutionPolicy, type DoomExecutionPolicy } from './doom-execution-policy.ts';

interface Point { x: number; y: number; z: number }
export interface PlanTarget extends Point { kind: 'point' | 'enemy' | 'pickup'; engineType?: number }
export type PlanStep = { label: string; target: PlanTarget; within?: number; maxTicks: number; direction?: 'strafeLeft' | 'strafeRight' } &
  ({ kind: 'face' | 'move' | 'attack' | 'strafeAttack' | 'use' } | { kind: 'equip'; weapon: Weapon });
export interface GamePlan { id: string; label: string; steps: PlanStep[]; family?: PlanFamily; evidence?: string; novelty?: number }
export interface RankedPlan extends GamePlan { probability: number }
export interface PlanExecution {
  skillsRevision?: number;
  guide?: string; plan: GamePlan; step: number; started: GameState; stepStarted: GameState; untilTick: number;
  tracked?: PlanTarget; status: PlanView['status']; reason?: string;
}
export const bearingTo = (s: Pick<GameState, 'x' | 'y' | 'angle'>, p: Point) => ((Math.atan2(p.y - s.y, p.x - s.x) * 180 / Math.PI - s.angle + 540) % 360) - 180;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const face = (target: PlanTarget): PlanStep => ({ kind: 'face', target, label: 'face the target', maxTicks: 105 });
const move = (target: PlanTarget, within = 24): PlanStep => ({ kind: 'move', target, within, label: target.kind === 'pickup' ? 'collect the pickup' : 'reach the opening', maxTicks: 140 });
const attack = (target: PlanTarget): PlanStep => ({ kind: 'attack', target, label: 'fire while aligned', maxTicks: 140 });

export function candidatePlans(state: GameState, map: DoomMap, visited?: string[], pickups?: PickupMemory): GamePlan[] {
  const plans: GamePlan[] = [];
  const melee = ['fist', 'chainsaw'].includes(state.weapon ?? '');
  const enemy = state.enemies.find(e => e.distance < 768 && plausibleRangedTarget(state, e, map)
    && (!melee || Math.abs(e.position.z - state.z) < 56)
    && state.enemies.filter(other => other.engineType === e.engineType && distance(other.position, e.position) < 8).length === 1);
  if (enemy && canAttack(state)) {
    const target: PlanTarget = { ...enemy.position, kind: 'enemy', engineType: enemy.engineType };
    // A firing angle does not establish a walkable route onto another floor.
    // Ranged weapons can engage from here; do not chase a ledge before firing.
    const approach = enemy.distance > (melee ? 48 : 224) && (melee || Math.abs(enemy.position.z - state.z) <= 24);
    plans.push({ id: 'engage', family: 'combat', label: 'engage the enemy', steps: [face(target), ...(approach ? [{ ...move(target, melee ? 40 : 192), label: 'approach firing range' }] : []), attack(target)] });
  }
  const pickup = state.pickups.find(p => [45, 53, 54, 55].includes(p.engineType)
    && state.health < ([45, 55].includes(p.engineType) ? 200 : 100)
    && p.distance <= 384 && Math.abs(p.position.z - state.z) <= 24 && map.sight(state, p.position) === 'unknown'
    && map.clearance(state, state.angle + p.relativeBearing) >= p.distance - 24);
  if (pickup) {
    const target: PlanTarget = { ...pickup.position, kind: 'pickup', engineType: pickup.engineType };
    plans.push({ id: 'recover', family: 'health', label: 'collect health', steps: [face(target), move(target)] });
  }
  // Distinct local openings. Static clearance is a candidate filter, never a
  // guarantee of reachability; actual movement and timeouts decide execution.
  const known = new Set(visited ?? []);
  const openings = [0, 45, -45, 90, -90, 180].map(offset => {
    const heading = state.angle + offset, clearance = map.clearance(state, heading, 256);
    const d = Math.max(32, Math.min(192, clearance - 16)), angle = heading * Math.PI / 180;
    const point = { ...state, x: state.x + Math.cos(angle) * d, y: state.y + Math.sin(angle) * d };
    return { heading, clearance, novelty: visited ? Number(!known.has(cell(point))) : undefined };
  }).sort((a, b) => (b.novelty ?? 0) - (a.novelty ?? 0) || b.clearance - a.clearance);
  const clear = openings.filter(o => o.clearance >= 64);
  const fresh = clear.filter(o => o.novelty === 1);
  const selected = (fresh.length ? fresh : clear).slice(0, enemy ? 2 : 4);
  if (!selected.length) selected.push(openings[0]!);
  for (const [i, opening] of selected.entries()) {
    const d = Math.max(32, Math.min(192, opening.clearance - 16)), angle = opening.heading * Math.PI / 180;
    const target: PlanTarget = { kind: 'point', x: state.x + Math.cos(angle) * d, y: state.y + Math.sin(angle) * d, z: state.z };
    const relative = bearingTo(state, target);
    const label = Math.abs(relative) > 135 ? 'explore behind' : relative > 67 ? 'explore left' : relative < -67 ? 'explore right' : relative > 22 ? 'explore ahead left' : relative < -22 ? 'explore ahead right' : 'explore ahead';
    plans.push({ id: `explore_${i}`, family: 'exploration', label, novelty: opening.novelty, steps: [{ ...face(target), label: 'face the opening' }, move(target)] });
  }
  if (visited?.length && !fresh.length) {
    const route = frontierRoute(state, map, known);
    if (route.length) {
      const first = route[0]!, second = route[1];
      plans.unshift({ id: 'frontier', family: 'exploration', label: 'leave the explored area', novelty: 1, steps: [
        { ...face(first), label: 'face the route out' }, { ...move(first, 16), label: 'follow the route out' },
        ...(second ? [{ ...move(second, 16), label: 'continue toward new space' }] : []),
      ] });
    }
  }
  if (enemy) {
    const away = openings.filter(o => Math.cos((o.heading - state.angle - enemy.relativeBearing) * Math.PI / 180) < -.25 && o.clearance >= 64)[0];
    if (away) {
      const d = Math.min(128, away.clearance - 16), radians = away.heading * Math.PI / 180;
      const target: PlanTarget = { kind: 'point', x: state.x + Math.cos(radians) * d, y: state.y + Math.sin(radians) * d, z: state.z };
      plans.push({ id: 'withdraw', family: 'cover', label: 'withdraw and face the enemy', steps: [{ ...face(target), label: 'face an escape route' }, { ...move(target), label: 'create distance' }, face({ ...enemy.position, kind: 'enemy', engineType: enemy.engineType })] });
    }
  }
  const expanded = [...interactionPlans(state, map), ...weaponPlans(state, map), ...plans.filter(p => p.family !== 'exploration'),
    ...resourcePlans(state, map), ...rememberedPickupPlans(state, map, pickups), ...tacticalPlans(state, map, enemy, canAttack(state)), ...plans.filter(p => p.family === 'exploration')];
  // Keep distinct goals in the model's menu before filling with variants. More
  // candidates do not change the session's independent simultaneous-future cap.
  const families = new Set<PlanFamily | undefined>();
  const first = expanded.filter(p => { if (families.has(p.family)) return false; families.add(p.family); return true; });
  return [...first, ...expanded.filter(p => !first.includes(p))].slice(0, doomPlanPolicy.maxCandidates);
}

/** Equipment alternatives are grounded in ownership and usable ammunition.
 * Jev or a generated planner chooses them; the motor never picks a weapon. */
export function weaponPlans(state: GameState, map: DoomMap): GamePlan[] {
  if (!state.weaponSelection || state.pendingWeapon || !state.weapons) return [];
  const enemy = state.enemies.find(e => e.distance < 768 && plausibleRangedTarget(state, e, map)
    && state.enemies.filter(other => other.engineType === e.engineType && distance(other.position, e.position) < 8).length === 1);
  const stranded = ['fist', 'chainsaw'].includes(state.weapon ?? '') || !weaponHasAmmo(state);
  if (!enemy && !stranded) return [];
  return state.weapons.filter(weapon => weapon !== state.weapon && weaponInput(state, weapon) && weaponHasAmmo(state, weapon))
    .flatMap(weapon => {
      const melee = weapon === 'fist' || weapon === 'chainsaw';
      // Do not propose downgrading to melee while a loaded ranged weapon works.
      if (melee && weaponHasAmmo(state)) return [];
      const target: PlanTarget = { kind: 'point', x: state.x, y: state.y, z: state.z };
      const steps: PlanStep[] = [{ kind: 'equip', weapon, target, label: `equip ${weapon}`, maxTicks: 105 }];
      if (enemy && !melee) {
        const actor: PlanTarget = { ...enemy.position, kind: 'enemy', engineType: enemy.engineType };
        steps.push(face(actor), attack(actor));
      }
      return [{ id: `equip_${weapon.replaceAll(' ', '_')}`, family: 'resource' as const,
        label: `equip ${weapon}${enemy && !melee ? ' and engage' : ''}`, steps }];
    });
}

export function startPlan(plan: GamePlan, state: GameState, ticks: number): PlanExecution {
  return { plan: structuredClone(plan), step: 0, started: structuredClone(state), stepStarted: structuredClone(state), untilTick: state.tick + ticks, status: 'running' };
}
export function planView(run: PlanExecution): PlanView {
  return { label: run.plan.label, steps: run.plan.steps.map(s => s.label), step: Math.min(run.step, run.plan.steps.length - 1), status: run.status, reason: run.reason };
}
export function stopPlan(run: PlanExecution, status: PlanExecution['status'], reason: string): Input[] {
  run.status = status; run.reason = reason; return [];
}

// Returns one tick of intent. The motor controller still handles collisions and
// shooting safety. No state prediction or engine state mutation is involved.
export function planInputs(run: PlanExecution, state: GameState, history: GameState[], map?: DoomMap, execution: Readonly<DoomExecutionPolicy> = defaultDoomExecutionPolicy, motor: Readonly<DoomMotorPolicy> = defaultDoomMotorPolicy): Input[] {
  if (run.status !== 'running') return [];
  if (state.tick >= run.untilTick) return stopPlan(run, 'horizon', 'comparison duration reached');
  if (!state.alive) return stopPlan(run, 'replan', 'player died');
  if (state.phase !== 'level' || state.map !== run.started.map || state.episode !== run.started.episode) return stopPlan(run, 'replan', 'game state changed');
  if (run.started.health - state.health >= execution.damageBeforeReplan) return stopPlan(run, 'replan', 'taking damage');
  if (state.enemies.some(e => e.distance < execution.nearbyThreatDistance && map?.sight(state, e.position) !== 'solid-wall-blocked' && !run.started.enemies.some(old => old.engineType === e.engineType && distance(old.position, e.position) < 128))) return stopPlan(run, 'replan', 'new nearby threat');
  while (run.step < run.plan.steps.length) {
    const step = run.plan.steps[run.step]!;
    if (step.kind === 'equip') {
      const input = weaponInput(state, step.weapon);
      if (!input) return stopPlan(run, 'replan', 'weapon selection unsupported or weapon unavailable');
      if (state.weapon === step.weapon && state.pendingWeapon === null) {
        run.step++; run.tracked = undefined; run.stepStarted = structuredClone(state); continue;
      }
      if (state.tick - run.stepStarted.tick >= step.maxTicks) return stopPlan(run, 'replan', 'weapon switch time limit reached');
      // Do not hold a toggle key across the switch or fire during the animation.
      // A later pulse can select the other shotgun after observing the first.
      return state.pendingWeapon ? [] : [input];
    }
    let target = run.tracked ?? step.target;
    if (target.kind !== 'point') {
      // The engine has no stable actor IDs. Match nearby same-type observations
      // conservatively; ambiguity requests a new judgment rather than switching targets.
      const observed = (target.kind === 'enemy' ? state.enemies : state.pickups).filter(e => e.engineType === target.engineType && distance(e.position, target) < (target.kind === 'enemy' ? 96 : 4)).sort((a, b) => distance(a.position, target) - distance(b.position, target));
      if (!observed.length || (observed[1] && distance(observed[1].position, target) - distance(observed[0]!.position, target) < 4)) {
        if (!observed.length && ((target.kind === 'pickup' && state.items > run.stepStarted.items) || (target.kind === 'enemy' && state.kills > run.stepStarted.kills))) return stopPlan(run, 'complete', 'target outcome observed');
        return stopPlan(run, 'replan', 'target lost or ambiguous');
      }
      target = run.tracked = { ...target, ...observed[0]!.position };
    }
    if (target.kind !== 'point' && map?.sight(state, target) === 'solid-wall-blocked') return stopPlan(run, 'replan', 'target became obstructed');
    if ((step.kind === 'attack' || step.kind === 'strafeAttack') && !canAttack(state)) return stopPlan(run, 'replan', 'weapon needs ammunition');
    const bearing = bearingTo(state, target);
    // Combat alignment and the motor's fire gate must use the same decision
    // policy; otherwise the plan stops turning where the motor refuses to fire.
    const alignment = target.kind === 'enemy' ? motor.aimToleranceDegrees : 7;
    const complete = step.kind === 'face' ? Math.abs(bearing) <= alignment : step.kind === 'move' && target.kind !== 'pickup' && distance(state, target) <= (step.within ?? 24);
    if (complete) {
      run.step++;
      const next = run.plan.steps[run.step]?.target;
      run.tracked = next && next.kind === step.target.kind && distance(next, step.target) < 1 ? target : undefined;
      run.stepStarted = structuredClone(state); continue;
    }
    if (step.kind === 'use' && state.tick - run.stepStarted.tick >= step.maxTicks && run.step + 1 < run.plan.steps.length) {
      run.step++; run.tracked = undefined; run.stepStarted = structuredClone(state); continue;
    }
    if (state.tick - run.stepStarted.tick >= step.maxTicks) return stopPlan(run,
      step.kind === 'strafeAttack' ? 'complete' : 'replan', step.kind === 'use' ? 'interaction attempted; re-observe the result' : step.kind === 'strafeAttack' ? 'moving attack interval complete' : 'step time limit reached');
    if (step.kind === 'use') {
      if (distance(state, target) > doomPlanPolicy.useDistance) return stopPlan(run, 'replan', 'interaction out of reach');
      if (Math.abs(bearing) > 7) return [bearing > 0 ? 'left' : 'right'];
      // Use is edge-triggered in Doom. Release between attempts.
      return (state.tick - run.stepStarted.tick) % execution.usePulseTicks === 0 ? ['use'] : [];
    }
    if (step.kind === 'strafeAttack') {
      const direction = step.direction ?? 'strafeLeft';
      if (!map || map.clearance(state, state.angle + (direction === 'strafeLeft' ? 90 : -90)) < 24) return stopPlan(run, 'replan', 'strafe route blocked');
      return [direction, ...(Math.abs(bearing) > motor.aimToleranceDegrees ? [bearing > 0 ? 'left' as const : 'right' as const] : ['fire' as const])];
    }
    if (step.kind === 'move') {
      const recent = history.filter(s => s.tick >= state.tick - 9 && s.tick >= run.stepStarted.tick && s.map === state.map && s.episode === state.episode);
      if (state.tick - run.stepStarted.tick >= execution.blockedAfterTicks && recent.length >= 8 && recent.every(s => distance(s, state) < 2 && Math.abs(s.angle - state.angle) < 4)) return stopPlan(run, 'replan', 'route blocked');
    }
    if (Math.abs(bearing) > (step.kind === 'move' ? 25 : alignment)) return [bearing > 0 ? 'left' : 'right'];
    return step.kind === 'attack' ? ['fire'] : ['forward', 'use'];
  }
  return stopPlan(run, 'complete', 'plan complete');
}

function canAttack(state: GameState) {
  if (state.weapon === 'fist' || state.weapon === 'chainsaw') return true;
  const weapon = state.weapon ?? 'unknown';
  const ammoIndex = ['shotgun', 'double shotgun'].includes(weapon) ? 1 : ['plasma gun', 'BFG'].includes(weapon) ? 2 : weapon === 'rocket launcher' ? 3 : 0;
  return (state.ammo[ammoIndex] ?? 0) >= (weapon === 'BFG' ? 40 : weapon === 'double shotgun' ? 2 : 1);
}

// Bounded static route hint to an unvisited cell, including revisited corridors
// needed to leave a room. Floors/doors can change: execution still validates
// progress and replans. This is not a globally shortest or guaranteed safe route.
export function frontierRoute(state: GameState, map: DoomMap, known: Set<string>): PlanTarget[] {
  const path = reachableRoute(state, map, p => !known.has(cell({ ...state, ...p })));
  const corners = path.filter((point, i) => {
    if (i === path.length - 1) return true;
    const previous = i ? path[i - 1]! : state, next = path[i + 1]!;
    return point.z !== previous.z || (point.x - previous.x) * (next.y - point.y) !== (point.y - previous.y) * (next.x - point.x);
  });
  return corners.slice(0, 2).map(p => ({ kind: 'point', x: p.x, y: p.y, z: p.z }));
}
