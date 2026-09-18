import { z } from 'zod';
import type { GameState } from '../../contracts/src/game.ts';

const weights = z.strictObject({
  health: z.number().finite().min(0).max(1000), kills: z.number().finite().min(0).max(1000),
  novelCells: z.number().finite().min(0).max(1000), items: z.number().finite().min(0).max(1000),
  secrets: z.number().finite().min(0).max(10000), ammo: z.number().finite().min(0).max(100),
  exit: z.number().finite().min(0).max(100000),
});
/** Mutable search preferences. These are never the independent acceptance metric. */
export const doomOutcomeWeightsSchema = z.strictObject({ survival: weights, exploration: weights, combat: weights });
export type DoomOutcomeWeights = z.infer<typeof doomOutcomeWeightsSchema>;
export type DoomOutcomePriority = keyof DoomOutcomeWeights;
const common = { health: 10, kills: 40, novelCells: 3, items: 10, secrets: 100, ammo: .1, exit: 100000 };
export const defaultDoomOutcomeWeights: Readonly<DoomOutcomeWeights> = Object.freeze({
  survival: Object.freeze({ ...common, health: 30 }),
  exploration: Object.freeze({ ...common, novelCells: 12 }),
  combat: Object.freeze({ ...common, kills: 150 }),
});

/** Search-only score; raw engine counters remain authoritative. Dead futures never become eligible. */
export function scoreDoomOutcome(before: GameState, after: GameState, priority: DoomOutcomePriority, novelCells = 0,
  shaping: Readonly<DoomOutcomeWeights> = defaultDoomOutcomeWeights): number {
  if (!after.alive) return -1000000;
  const selected = shaping[priority];
  const sameMap = before.map === after.map && before.episode === after.episode;
  const exited = !sameMap || after.phase === 'intermission';
  return Number(exited) * selected.exit + (after.health - before.health) * selected.health
    + Math.max(0, after.kills - (sameMap ? before.kills : 0)) * selected.kills
    + Math.max(0, novelCells) * selected.novelCells
    + Math.max(0, after.items - (sameMap ? before.items : 0)) * selected.items
    + Math.max(0, after.secrets - (sameMap ? before.secrets : 0)) * selected.secrets
    + (after.ammo.reduce((a, b) => a + b, 0) - before.ammo.reduce((a, b) => a + b, 0)) * selected.ammo;
}
