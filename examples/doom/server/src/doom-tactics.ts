import { pickupMemoryPolicy, type PickupMemory } from './doom-pickup-memory.ts';
import type { GameState } from '../../contracts/src/game.ts';
import type { EntityObservation } from '../../contracts/src/entity.ts';
import { lockedKey, type DoomMap } from './doom-geometry.ts';
import type { GamePlan, PlanStep, PlanTarget } from './doom-plans.ts';
import { doomPlanPolicy as policy } from './doom-plan-policy.ts';

type Point = { x: number; y: number; z: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
const target = (p: Point): PlanTarget => ({ kind: 'point', x: p.x, y: p.y, z: p.z });
const face = (p: PlanTarget, label = 'face the target'): PlanStep => ({ kind: 'face', target: p, label, maxTicks: 105 });
const move = (p: PlanTarget, label = 'reach the waypoint'): PlanStep => ({ kind: 'move', target: p, label, within: 16, maxTicks: 140 });

// Classic Doom use-line IDs, from id Software p_switch.c / P_UseSpecialLine.
// Excludes crushers, close-door switches and locked doors: inventory and live
// linedef activation state are not exposed by this bridge.
const doors = new Set([1, 31, 117, 118]);
const switches = new Set([7, 9, 14, 15, 18, 20, 21, 23, 29, 61, 62, 63, 66, 67, 68, 69, 70, 71, 101, 102, 103, 111, 112, 114, 115, 122, 123, 127, 131, 132]);
const exits = new Set([11, 51]);

/** Known static interaction sites, approached from the usable (front) side.
 * Completion records an attempted use, never an unobserved door opening.
 */
export function interactionPlans(state: GameState, map: DoomMap): GamePlan[] {
  const options: Array<GamePlan & { distance: number }> = [];
  for (const [index, wall] of map.walls.entries()) {
    if (!(lockedKey(wall.special) && state.keys?.includes(lockedKey(wall.special)!)) && !doors.has(wall.special) && !switches.has(wall.special) && !exits.has(wall.special)) continue;
    const dx = wall.b.x - wall.a.x, dy = wall.b.y - wall.a.y, length = Math.hypot(dx, dy);
    if (length < 32 || dx * (state.y - wall.a.y) - dy * (state.x - wall.a.x) >= 0) continue;
    const fraction = Math.max(16 / length, Math.min(1 - 16 / length, ((state.x - wall.a.x) * dx + (state.y - wall.a.y) * dy) / (length * length)));
    const site = target({ x: wall.a.x + fraction * dx, y: wall.a.y + fraction * dy, z: state.z });
    const approach = target({ x: site.x + dy / length * 32, y: site.y - dx / length * 32, z: state.z });
    const d = distance(state, approach);
    if (d > policy.interactionRadius || map.sight(state, approach) !== 'unknown'
      || map.clearance(state, heading(state, approach), d + 32) < d) continue;
    const exit = exits.has(wall.special), door = doors.has(wall.special);
    options.push({ id: `${exit ? 'exit' : 'interact'}_${index}`, family: exit ? 'exit' : 'interaction', distance: d,
      label: exit ? 'try the level exit' : door ? 'open a nearby door' : 'activate a nearby switch',
      evidence: 'Static map interaction; current activation state unknown. Use is attempted, success must be observed.',
      steps: [move(approach, 'approach the usable side'), face(site), { kind: 'use', target: site, label: 'press use and check the result', maxTicks: policy.interactionTicks }] });
  }
  options.sort((a, b) => a.distance - b.distance);
  return ['exit', 'interaction'].flatMap(family => options.filter(p => p.family === family).slice(0, 1).map(({ distance: _, ...p }) => p));
}

const ammoIndex: Record<number, number> = { 63: 0, 64: 0, 65: 3, 66: 3, 67: 2, 68: 2, 69: 1, 70: 1 };
const weapons: Record<number, string> = { 72: 'BFG', 73: 'chaingun', 74: 'chainsaw', 75: 'rocket launcher', 76: 'plasma gun', 77: 'shotgun', 78: 'double shotgun' };
function resourceLabel(s: GameState, p: Pick<EntityObservation, 'engineType'>): string | undefined {
  if ([45, 53, 54, 55].includes(p.engineType) && s.health < ([45, 55].includes(p.engineType) ? 200 : 100)) return 'collect health';
  if (p.engineType >= 47 && p.engineType <= 52) return 'collect a nearby key';
  if ((p.engineType === 43 && s.armor < 100) || ([44, 46].includes(p.engineType) && s.armor < 200)) return 'collect armor';
  if (p.engineType === 62 && (s.health < 200 || s.armor < 200)) return 'collect health and armor';
  if (p.engineType === 57 && s.health < 100) return 'collect berserk health recovery';
  const index = ammoIndex[p.engineType];
  if (index !== undefined && (s.ammo[index] ?? 0) < policy.lowAmmo[index]!) return 'replenish ammunition';
  if (p.engineType === 71 && s.ammo.some((amount, i) => amount < (policy.lowAmmo[i] ?? 0))) return 'collect backpack ammunition';
  // Ownership is unknown; only propose an evident upgrade from basic weapons.
  if (weapons[p.engineType] && ['fist', 'pistol', 'chainsaw'].includes(s.weapon ?? '') && weapons[p.engineType] !== s.weapon)
    return `collect ${weapons[p.engineType]}`;
  return undefined;
}

export function resourcePlans(state: GameState, map: DoomMap): GamePlan[] {
  const found = new Map<string, GamePlan>();
  for (const p of [...state.pickups].sort((a, b) => a.distance - b.distance)) {
    const label = resourceLabel(state, p);
    if (!label || label === 'collect health' || found.has(label) || p.distance > policy.pickupRadius || Math.abs(p.position.z - state.z) > 24
      || map.sight(state, p.position) !== 'unknown' || map.clearance(state, heading(state, p.position), p.distance + 32) < p.distance - 16) continue;
    const t: PlanTarget = { ...p.position, kind: 'pickup', engineType: p.engineType };
    found.set(label, { id: `resource_${p.engineType}`, label, family: label.includes('key') ? 'key' : 'resource',
      evidence: 'Currently observed pickup; inventory ownership is not known.', steps: [face(t), move(t, 'collect the pickup')] });
  }
  return [...found.values()];
}

/** Small static breadth-first search. Returns a bounded prefix of a route to a
 * qualifying point; callers must not describe a prefix as already in cover.
 */
export function tacticalRoute(state: GameState, map: DoomMap, qualifies: (p: Point) => boolean): PlanTarget[] {
  const queue: Array<Point & { parent: number }> = [{ x: state.x, y: state.y, z: state.z, parent: -1 }];
  const seen = new Set(['0:0']);
  for (let i = 0; i < queue.length && i < policy.routeNodes; i++) {
    const here = queue[i]!;
    if (i && qualifies(here)) {
      const path: Point[] = []; let at = i;
      while (at > 0) { path.unshift(queue[at]!); at = queue[at]!.parent; }
      const corners = path.filter((p, j) => {
        if (j === path.length - 1) return true;
        const previous = j ? path[j - 1]! : state, next = path[j + 1]!;
        return (p.x - previous.x) * (next.y - p.y) !== (p.y - previous.y) * (next.x - p.x);
      });
      return corners.slice(0, policy.maxWaypoints).map(target);
    }
    for (const [dx, dy, angle] of [[policy.routeStep, 0, 0], [0, policy.routeStep, 90], [-policy.routeStep, 0, 180], [0, -policy.routeStep, 270]] as const) {
      const p = { x: here.x + dx, y: here.y + dy, z: state.z }, key = `${p.x - state.x}:${p.y - state.y}`;
      if (seen.has(key) || distance(state, p) > policy.routeRadius || map.clearance(here, angle, policy.routeStep + 32) < policy.routeStep) continue;
      seen.add(key); queue.push({ ...p, parent: i });
    }
  }
  return [];
}

export function tacticalPlans(state: GameState, map: DoomMap, enemy: EntityObservation | undefined, armed: boolean): GamePlan[] {
  const plans: GamePlan[] = [];
  if (enemy) {
    const t: PlanTarget = { ...enemy.position, kind: 'enemy', engineType: enemy.engineType };
    const aim = heading(state, t);
    const sides = ([['strafeLeft', 90], ['strafeRight', -90]] as const)
      .map(([direction, offset]) => ({ direction, clearance: map.clearance(state, aim + offset) }))
      .filter(p => p.clearance >= policy.strafeClearance).sort((a, b) => b.clearance - a.clearance);
    if (armed && enemy.distance >= 64 && !['fist', 'chainsaw'].includes(state.weapon ?? '') && sides[0]) {
      plans.push({ id: 'strafe_attack', family: 'combat', label: 'attack while strafing', steps: [face(t),
        { kind: 'strafeAttack', target: t, direction: sides[0].direction, label: 'strafe and fire while aligned', maxTicks: policy.strafeTicks }] });
    }
    const route = tacticalRoute(state, map, p => map.sight(enemy.position, p) === 'solid-wall-blocked');
    if (route.length) plans.push({ id: 'cover', family: 'cover', label: 'move toward cover',
      evidence: 'Static route toward cover from this enemy only; other threats and dynamic geometry may differ.',
      steps: [face(route[0]!), ...route.map(p => move(p, 'follow the route toward cover'))] });
  }
  const blocked = [...state.enemies].filter(e => e.distance < policy.routeRadius && Math.abs(e.position.z - state.z) <= 24
    && map.sight(state, e.position) === 'solid-wall-blocked').sort((a, b) => a.distance - b.distance)[0];
  if (blocked) {
    const route = tacticalRoute(state, map, p => map.sight(p, blocked.position) === 'unknown' && distance(p, blocked.position) <= 384);
    if (route.length) plans.push({ id: 'reposition', family: 'reposition', label: 'approach from another angle',
      evidence: 'Route toward a possible firing angle; re-observe before attacking.', steps: [face(route[0]!), ...route.map(p => move(p, 'work around the obstruction'))] });
  }
  return plans;
}

/** Return toward a previously observed useful resource. Memory is a hint; this
 * plan navigates to re-observe, and never fabricates a live pickup observation.
 */
export function rememberedPickupPlans(state: GameState, map: DoomMap, memory?: PickupMemory): GamePlan[] {
  if (!memory || memory.map !== state.map || memory.episode !== state.episode) return [];
  const records = [...memory.entries].sort((a, b) => distance(state, a) - distance(state, b));
  for (const p of records) {
    if (state.tick < p.seenTick || state.tick - p.seenTick > pickupMemoryPolicy.maxAgeTicks || Math.abs(p.z - state.z) > 24) continue;
    const d = distance(state, p);
    const live = state.pickups.find(e => e.engineType === p.engineType && distance(e.position, p) < 4);
    if (live && map.sight(state, p) === 'unknown' && map.clearance(state, heading(state, p), d + 32) >= d - 16) continue;
    const label = resourceLabel(state, { engineType: p.engineType });
    if (!label || d < 32) continue;
    const route = tacticalRoute(state, map, q => distance(q, p) < 32 || distance(q, p) < d - 128);
    if (route.length) return [{ id: 'return_pickup', family: 'resupply', label: `return toward a known pickup (${label})`,
      evidence: `Last observed ${Math.round((state.tick - p.seenTick) / 35)}s ago; availability must be rechecked.`,
      steps: [face(route[0]!), ...route.map(q => move(q, 'return and recheck the resource'))] }];
  }
  return [];
}
