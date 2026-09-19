import type { GameState } from '../../contracts/src/game.ts';
import type { EntityObservation } from '../../contracts/src/entity.ts';
import type { DoomMap } from './doom-geometry.ts';

export const isMeleeWeapon = (weapon: string | undefined): boolean => weapon === 'fist' || weapon === 'chainsaw';

// wasmdoom dd321b50 info.c mobjinfo radii, indexed by observed engine type.
// Include large monsters: their centers can be far away at physical contact.
const enemyRadii: Readonly<Record<number, number>> = {
  1: 20, 2: 20, 3: 20, 5: 20, 8: 48, 10: 20, 11: 20, 12: 30, 13: 30,
  14: 31, 15: 24, 17: 24, 18: 16, 19: 128, 20: 64, 21: 40, 22: 31, 23: 20, 24: 16,
};

/** Range eligibility from the pinned engine's 64-unit MELEERANGE and known
 * actor radius. Unknown types use center distance. Exact intercept geometry and
 * engine line of sight are unknown, so passing does not guarantee contact. */
export function withinMeleeReach(state: Pick<GameState, 'x' | 'y' | 'z'>, target: { x: number; y: number; z: number }, engineType?: number): boolean {
  const radius = engineType === undefined ? 0 : enemyRadii[engineType] ?? 0;
  return Math.hypot(target.x - state.x, target.y - state.y) <= 64 + radius && Math.abs(target.z - state.z) <= 56;
}

/** A distant enemy may be worth approaching without being a firing target. */
export function plausibleAttackTarget(state: GameState, enemy: EntityObservation, map: DoomMap): boolean {
  return plausibleRangedTarget(state, enemy, map) && (!isMeleeWeapon(state.weapon) || withinMeleeReach(state, enemy.position, enemy.engineType));
}

/** Shared planner/motor eligibility, not proof of engine line of sight.
 * Static walls and uncertain moving openings remain excluded. Height scales
 * with range because a target on another floor can still be in firing range.
 */
export function plausibleRangedTarget(state: GameState, enemy: EntityObservation, map: DoomMap): boolean {
  return map.sight(state, enemy.position) === 'unknown'
    && Math.abs(enemy.position.z - state.z) <= Math.max(56, enemy.distance * .625);
}
