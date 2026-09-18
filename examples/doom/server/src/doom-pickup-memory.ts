import type { GameState } from '../../contracts/src/game.ts';
export interface RememberedPickup { engineType: number; x: number; y: number; z: number; seenTick: number }
export interface PickupMemory { episode: number; map: number; entries: RememberedPickup[] }
export const pickupMemoryPolicy = { capacity: 64, maxAgeTicks: 2100 } as const;
const same = (a: RememberedPickup, b: RememberedPickup) => a.engineType === b.engineType && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 4;
/** World-local observations, copied on fork/rollback. Absence is evidence only
 * when the bridge's 16-pickup observation list is not truncated.
 */
export function observePickups(state: GameState, old?: PickupMemory): PickupMemory {
  const current = state.pickups.map(p => ({ ...p.position, engineType: p.engineType, seenTick: state.tick }));
  const retained = old?.episode === state.episode && old.map === state.map ? old.entries.filter(p =>
    p.seenTick <= state.tick && state.tick - p.seenTick <= pickupMemoryPolicy.maxAgeTicks
    && !current.some(q => same(p, q))
    && !(state.pickups.length < 16 && Math.hypot(p.x - state.x, p.y - state.y) <= state.telemetry.radius)) : [];
  return { episode: state.episode, map: state.map, entries: [...current, ...retained].sort((a, b) => b.seenTick - a.seenTick).slice(0, pickupMemoryPolicy.capacity).map(p => ({ ...p })) };
}
