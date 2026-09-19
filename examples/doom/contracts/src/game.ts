import type { EntityObservation } from './entity.ts';
import { z } from 'zod';

export const weapons = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocket launcher', 'plasma gun', 'BFG', 'chainsaw', 'double shotgun'] as const;
export const weaponSchema = z.enum(weapons);
export type Weapon = z.infer<typeof weaponSchema>;
export const weaponInputs = ['weapon1', 'weapon2', 'weapon3', 'weapon4', 'weapon5', 'weapon6', 'weapon7', 'weapon8'] as const;
export type WeaponInput = typeof weaponInputs[number];
export const inputSchema = z.enum(['forward', 'backward', 'left', 'right', 'strafeLeft', 'strafeRight', 'fire', 'use', ...weaponInputs]);
export type Input = z.infer<typeof inputSchema>;
export const stepSchema = z.object({
  // One bounded chunk makes cancellation and takeover latency predictable.
  ticks: z.number().int().min(1).max(35),
  inputs: z.array(inputSchema).max(8),
}).strict();
export type Step = z.infer<typeof stepSchema>;
export type KeyColor = 'blue' | 'yellow' | 'red';
export type ProgressEvent = { tick: number } & ({ kind: 'locked' | 'key'; key: KeyColor } | { kind: 'door'; sector: number; direction: number } | { kind: 'switch'; line: number } | { kind: 'lift'; sector: number } | { kind: 'message'; text: string });
export interface GameState {
  // Absent on older detached bridges; absent inventory is unknown, not empty.
  keys?: KeyColor[];
  progressEvents?: ProgressEvent[];
  keyPickups?: EntityObservation[];

  tick: number;
  health: number;
  armor: number;
  ammo: number[];
  // Optional for detached bridges and recordings created before weapon telemetry.
  weapon?: string;
  weapons?: Weapon[];
  // null means no switch is pending; absence means legacy telemetry is unknown.
  pendingWeapon?: Weapon | null;
  // Advertised only by a bridge instance whose request schema accepts weapon keys.
  weaponSelection?: true;
  kills: number;
  items: number;
  secrets: number;
  x: number;
  y: number;
  angle: number;
  episode: number;
  map: number;
  phase: 'level' | 'intermission' | 'finale' | 'demo';
  alive: boolean;
  z: number;
  velocity: { x: number; y: number; z: number };
  enemies: EntityObservation[];
  projectiles: EntityObservation[];
  pickups: EntityObservation[];
  telemetry: { radius: number; lineOfSightKnown: false; engineObjectCount: number };

}
