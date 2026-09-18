import type { ScopedGoal } from '@multiverse/gameplay-harness';
import type { KeyColor } from './game.ts';

export type DoomGoalTarget =
  | { kind: 'position'; x: number; y: number; z: number; within: number }
  | { kind: 'health'; minimum: number }
  | { kind: 'kills'; minimum: number }
  | { kind: 'key'; color: KeyColor }
  | { kind: 'exit' };
export interface DoomTemporaryGoal { key: string; record: ScopedGoal<DoomGoalTarget> }
