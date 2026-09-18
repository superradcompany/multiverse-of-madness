import { isDeepStrictEqual } from 'node:util';
import type { EntityObservation } from '../../../packages/contracts/src/entity.ts';
import type { GameState } from '../../../packages/contracts/src/game.ts';
import type { GamePlan, PlanExecution } from './doom-plans.ts';

export const decisionLeadTicks = 28;
const distance = (a: EntityObservation['position'], b: EntityObservation['position']) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const actors = (items: EntityObservation[]) => items.map(({ distance: _distance, relativeBearing: _bearing,
  towardPlayerAlignment: _alignment, ...actor }) => actor).sort((a, b) => a.engineType - b.engineType
    || a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z);
function facts({ tick: _tick, x: _x, y: _y, z: _z, angle: _angle, velocity: _velocity,
  enemies: _enemies, pickups: _pickups, telemetry, ...state }: GameState) {
  return { ...state, projectiles: actors(state.projectiles), keyPickups: state.keyPickups && actors(state.keyPickups),
    telemetry: { radius: telemetry.radius, lineOfSightKnown: telemetry.lineOfSightKnown } };
}
function enemyContextCurrent(before: GameState, current: GameState): boolean {
  if (before.enemies.length !== current.enemies.length) return false;
  const unused = new Set(current.enemies);
  for (const enemy of before.enemies) {
    const matches = [...unused].filter(actor => actor.engineType === enemy.engineType && actor.health === enemy.health)
      .map(actor => ({ actor, moved: distance(enemy.position, actor.position) })).sort((a, b) => a.moved - b.moved);
    const match = matches[0];
    // Same conservative tracking window as the conditional-plan motor. A newly
    // close enemy or ambiguous identity changes tactical urgency and needs a fresh judgment.
    if (!match || match.moved >= 96 || matches[1] && matches[1].moved - match.moved < 4
      || enemy.distance >= 160 && match.actor.distance < 160) return false;
    unused.delete(match.actor);
  }
  return true;
}
function targetStillObserved(plan: GamePlan, current: GameState): boolean {
  return plan.steps.every(({ target }) => {
    if (target.kind === 'point') return true;
    const pool = target.kind === 'enemy' ? current.enemies : current.pickups;
    const matches = pool.filter(actor => actor.engineType === target.engineType)
      .map(actor => distance(actor.position, target)).filter(moved => moved < (target.kind === 'enemy' ? 96 : 4)).sort((a, b) => a - b);
    return matches.length > 0 && (matches.length === 1 || matches[1]! - matches[0]! >= 4);
  });
}
/** Diagnostics contain field names only, not game or model payloads. */
export function decisionFactChanges(before: GameState, current: GameState): string[] {
  const left = facts(before), right = facts(current);
  return Object.keys(left).filter(key => !isDeepStrictEqual(left[key as keyof typeof left], right[key as keyof typeof right]));
}
/** Re-ground absolute targets after bounded motion. Resources, progress, map events and tactical urgency stay authoritative. */
export function decisionStateIsCurrent(before: GameState, current: GameState, plan?: PlanExecution, candidates?: GamePlan[]): boolean {
  const newNearbyPickup = current.pickups.some(actor => actor.distance < 160 && !before.pickups.some(old =>
    old.engineType === actor.engineType && distance(old.position, actor.position) < 4));
  return current.alive && current.phase === 'level' && current.tick >= before.tick
    && current.tick - before.tick <= decisionLeadTicks
    && Math.hypot(current.x - before.x, current.y - before.y) <= 128 && Math.abs(current.z - before.z) < 4
    && plan?.status !== 'replan' && isDeepStrictEqual(facts(before), facts(current))
    && enemyContextCurrent(before, current) && !newNearbyPickup
    && (candidates === undefined || candidates.every(candidate => targetStillObserved(candidate, current)));
}
