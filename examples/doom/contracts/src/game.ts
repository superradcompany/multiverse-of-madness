import type { EntityObservation } from './entity.ts';
import { z } from 'zod';

export const inputSchema = z.enum(['forward', 'backward', 'left', 'right', 'strafeLeft', 'strafeRight', 'fire', 'use']);
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
