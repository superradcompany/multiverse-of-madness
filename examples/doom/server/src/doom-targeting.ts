import type { GameState } from '../../contracts/src/game.ts';
import type { EntityObservation } from '../../contracts/src/entity.ts';
import type { DoomMap } from './doom-geometry.ts';

/** Shared planner/motor eligibility, not proof of engine line of sight.
 * Static walls and uncertain moving openings remain excluded. Height scales
 * with range because a target on another floor can still be in firing range.
 */
export function plausibleRangedTarget(state: GameState, enemy: EntityObservation, map: DoomMap): boolean {
  return map.sight(state, enemy.position) === 'unknown'
    && Math.abs(enemy.position.z - state.z) <= Math.max(56, enemy.distance * .625);
}
