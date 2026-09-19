import { weaponInputs } from '../../contracts/src/game.ts';
import type { GameState, Input } from '../../contracts/src/game.ts';
import type { DoomMap } from './doom-geometry.ts';
import { plausibleRangedTarget } from './doom-targeting.ts';
import { defaultDoomMotorPolicy, type DoomMotorPolicy } from './doom-motor-policy.ts';

// Motor assistance, not a model judgment or a simulated future. Rechecked from
// the current state each game tick. Unknown dynamic doors remain a limitation.
export function doomInputs(state: GameState, requested: Input[], map: DoomMap, stopOnTarget = true, motor: Readonly<DoomMotorPolicy> = defaultDoomMotorPolicy): Input[] {
  if (!requested.length) return [];
  if (requested.some(input => (weaponInputs as readonly string[]).includes(input))) return requested.filter(input => input !== 'fire');
  const candidates = state.enemies.filter(e => plausibleRangedTarget(state, e, map));
  const aligned = candidates.some(e => Math.abs(e.relativeBearing) <= motor.aimToleranceDegrees);
  let inputs = [...requested];
  const turning = inputs.includes('left') ? 1 : inputs.includes('right') ? -1 : 0;
  if (turning && stopOnTarget) {
    // Stop a turn when aim reaches a plausible target instead of holding the
    // turn key for the entire one-to-six-second decision interval.
    const target = candidates.filter(e => Math.abs(e.relativeBearing) <= motor.turnToTargetDegrees
      && (Math.sign(e.relativeBearing) === turning || Math.abs(e.relativeBearing) <= motor.aimToleranceDegrees))
      .sort((a, b) => Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing))[0];
    if (target) {
      inputs = inputs.filter(i => i !== 'forward');
      if (Math.abs(target.relativeBearing) <= motor.aimToleranceDegrees) inputs = inputs.filter(i => i !== 'left' && i !== 'right');
    }
  }
  inputs = inputs.filter(i => i !== 'fire');
  // Fire only with plausible aim. Other movement continues; no automatic
  // turning, path selection, player-state writes, or fabricated visibility.
  if (aligned) inputs.push('fire');
  return inputs;
}
