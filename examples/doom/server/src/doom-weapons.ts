import type { GameState, Weapon, WeaponInput } from '../../contracts/src/game.ts';

const slots: Record<Weapon, WeaponInput> = {
  fist: 'weapon1', pistol: 'weapon2', shotgun: 'weapon3', chaingun: 'weapon4',
  'rocket launcher': 'weapon5', 'plasma gun': 'weapon6', BFG: 'weapon7',
  chainsaw: 'weapon8', 'double shotgun': 'weapon3',
};

/** Real keyboard controls, never inventory or player-state writes. Slot 3 toggles
 * shotguns; callers release while pending and verify the equipped result. */
export function weaponInput(state: GameState, weapon: Weapon): WeaponInput | undefined {
  if (!state.weaponSelection || !state.weapons?.includes(weapon)) return undefined;
  // Slot 1 prefers the chainsaw unless berserk is active. We do not observe
  // berserk yet, so cannot promise a fist selection while owning a chainsaw.
  if (weapon === 'fist' && state.weapons.includes('chainsaw')) return undefined;
  return slots[weapon];
}

export function weaponAmmoIndex(weapon: string | undefined): number | undefined {
  if (!weapon || !Object.hasOwn(slots, weapon) || weapon === 'fist' || weapon === 'chainsaw') return undefined;
  return ['shotgun', 'double shotgun'].includes(weapon) ? 1
    : ['plasma gun', 'BFG'].includes(weapon) ? 2 : weapon === 'rocket launcher' ? 3 : 0;
}

export function weaponHasAmmo(state: GameState, weapon: string | undefined = state.weapon): boolean {
  if (weapon === 'fist' || weapon === 'chainsaw') return true;
  const index = weaponAmmoIndex(weapon);
  if (index === undefined) return false;
  return (state.ammo[index] ?? 0) >= (weapon === 'BFG' ? 40 : weapon === 'double shotgun' ? 2 : 1);
}
