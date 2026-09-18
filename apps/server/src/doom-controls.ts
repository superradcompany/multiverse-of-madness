import type { GameState, Input } from '../../../packages/contracts/src/game.ts';
import type { DoomMap } from './doom-geometry.ts';
import { plausibleRangedTarget } from './doom-targeting.ts';

// Motor assistance, not a model judgment or a simulated future. Rechecked from
// the current state each game tick. Unknown dynamic doors remain a limitation.
export function doomInputs(state: GameState, requested: Input[], map: DoomMap, stopOnTarget = true): Input[] {
  if (!requested.length) return [];
  const candidates = state.enemies.filter(e => plausibleRangedTarget(state, e, map));
  const aligned = candidates.some(e => Math.abs(e.relativeBearing) <= 6);
  let inputs = [...requested];
  const turning = inputs.includes('left') ? 1 : inputs.includes('right') ? -1 : 0;
  if (turning && stopOnTarget) {
    // Stop a turn when aim reaches a plausible target instead of holding the
    // turn key for the entire one-to-six-second decision interval.
    const target = candidates.filter(e => Math.abs(e.relativeBearing) <= 80
      && (Math.sign(e.relativeBearing) === turning || Math.abs(e.relativeBearing) <= 6))
      .sort((a, b) => Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing))[0];
    if (target) {
      inputs = inputs.filter(i => i !== 'forward');
      if (Math.abs(target.relativeBearing) <= 6) inputs = inputs.filter(i => i !== 'left' && i !== 'right');
    }
  }
  inputs = inputs.filter(i => i !== 'fire');
  // Fire only with plausible aim. Other movement continues; no automatic
  // turning, path selection, player-state writes, or fabricated visibility.
  if (aligned) inputs.push('fire');
  return inputs;
}
