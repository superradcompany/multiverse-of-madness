import { z } from 'zod';
import type { DoomExecutionPolicy } from './doom-execution-policy.ts';

/** Motor preferences, separate from observed geometry and engine input rules. */
export const doomMotorPolicySchema = z.strictObject({
  stalledTicks: z.number().int().min(2).max(70),
  escapeTicks: z.number().int().min(7).max(350),
  escapeDistance: z.number().min(16).max(256),
  minimumClearance: z.number().min(16).max(64),
  lookaheadTicks: z.number().min(1).max(12),
  routeClearance: z.number().min(32).max(192),
  aimToleranceDegrees: z.number().min(1).max(12),
  turnToTargetDegrees: z.number().min(12).max(120),
});
export type DoomMotorPolicy = z.infer<typeof doomMotorPolicySchema>;
export interface DoomControlPolicy { motor?: Readonly<DoomMotorPolicy>; execution?: Readonly<DoomExecutionPolicy> }
export const defaultDoomMotorPolicy: Readonly<DoomMotorPolicy> = Object.freeze({
  stalledTicks: 7, escapeTicks: 70, escapeDistance: 64, minimumClearance: 20,
  lookaheadTicks: 4, routeClearance: 96, aimToleranceDegrees: 6, turnToTargetDegrees: 80,
});
