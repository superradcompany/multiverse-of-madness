import { z } from 'zod';

/** Adjustable plan behavior. Engine rules, collision checks and input legality stay host-owned. */
export const doomExecutionPolicySchema = z.strictObject({
  damageBeforeReplan: z.number().int().min(1).max(100),
  nearbyThreatDistance: z.number().min(0).max(768),
  blockedAfterTicks: z.number().int().min(1).max(350),
  usePulseTicks: z.number().int().min(2).max(35),
});
export type DoomExecutionPolicy = z.infer<typeof doomExecutionPolicySchema>;

/** Omitted in historical policies; preserves their original execution behavior. */
export const defaultDoomExecutionPolicy: Readonly<DoomExecutionPolicy> = Object.freeze({
  damageBeforeReplan: 8, nearbyThreatDistance: 160, blockedAfterTicks: 35, usePulseTicks: 7,
});
