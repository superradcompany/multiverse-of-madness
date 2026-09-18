/** Adapter tuning, in Doom world units and game ticks (35 ticks/second).
 * These are code defaults, not browser settings. See GAMEPLAY-HARNESS.md.
 */
export const doomPlanPolicy = {
  maxCandidates: 10,
  pickupRadius: 384,
  interactionRadius: 384,
  // wasmdoom dd321b50 src/p_local.h: USERANGE is 64 world units.
  // A nearer host cutoff rejects valid attempts after ordinary movement inertia.
  useDistance: 64,
  interactionTicks: 35,
  strafeClearance: 64,
  strafeTicks: 70,
  routeRadius: 384,
  routeStep: 64,
  routeNodes: 128,
  maxWaypoints: 2,
  lowAmmo: [100, 25, 150, 25] as readonly number[],
} as const;
export type PlanFamily = 'combat' | 'health' | 'resource' | 'key' | 'interaction' | 'exit' | 'exploration' | 'cover' | 'reposition' | 'resupply';
