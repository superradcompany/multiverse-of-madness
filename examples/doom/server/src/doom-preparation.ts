import { z } from 'zod';
import { canonicalJson } from '@multiverse/gameplay-harness';
import type { GameState } from '../../contracts/src/game.ts';
import type { GamePlan } from './doom-plans.ts';
import type { Experience } from './experience.ts';
import { cell } from './run-stats.ts';

const coordinate = z.number().finite().min(-1048576).max(1048576);
const target = z.strictObject({ x: coordinate, y: coordinate, z: coordinate, kind: z.enum(['point', 'enemy', 'pickup']), engineType: z.number().int().nonnegative().optional() });
const plan = z.strictObject({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(120),
  family: z.enum(['combat', 'health', 'resource', 'key', 'interaction', 'exit', 'exploration', 'cover', 'reposition', 'resupply']).optional(),
  steps: z.array(z.strictObject({ kind: z.enum(['face', 'move', 'attack', 'strafeAttack', 'use']), direction: z.enum(['strafeLeft', 'strafeRight']).optional(),
    label: z.string().trim().min(1).max(120), target, within: z.number().min(1).max(256).optional(), maxTicks: z.number().int().min(1).max(2100) })).min(1).max(12),
});
const indices = z.array(z.number().int().nonnegative());
export const doomPreparationSchema = z.strictObject({
  abi: z.literal('doom-preparation/1'),
  plans: z.array(plan).min(1).max(10).optional(),
  historyIndices: indices.max(10), experienceIndices: indices.max(8),
  features: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/), z.union([z.number().finite(), z.boolean(), z.string().max(160)])),
});
export interface DoomPreparationPool {
  state: GameState; history: GameState[]; experience: Experience[]; planTicks?: number; experienceLimit: number; visited?: string[];
}
export interface PreparedDoomContext {
  historyIndices: number[]; experienceIndices: number[];
  history: GameState[]; experience: Experience[]; plans?: GamePlan[];
  features: Record<string, string | number | boolean>;
}
/** Validate proposals, then attach only observations from the captured host pool. No fabricated memory or actor identity. */
export function prepareDoomContext(value: unknown, pool: DoomPreparationPool): PreparedDoomContext {
  const parsed = doomPreparationSchema.parse(value);
  if (Object.keys(parsed.features).length > 24 || Buffer.byteLength(canonicalJson(parsed.features)) > 2048) throw new Error('Prepared features exceed their context budget');
  const select = <T>(ids: number[], entries: T[], maximum: number) => {
    if (ids.length > maximum || new Set(ids).size !== ids.length || ids.some(id => id >= entries.length)) throw new Error('Prepared context contains invalid or duplicate evidence indices');
    return ids.map(id => structuredClone(entries[id]!));
  };
  if (parsed.historyIndices.some((id, i) => i > 0 && id <= parsed.historyIndices[i - 1]!)) throw new Error('Prepared history must remain chronological');
  const history = select(parsed.historyIndices, pool.history, 10), experience = select(parsed.experienceIndices, pool.experience, pool.experienceLimit);
  if (parsed.plans && !pool.planTicks) throw new Error('Prepared plans cannot override action-only mode');
  if (parsed.plans && new Set(parsed.plans.map(item => item.id)).size !== parsed.plans.length) throw new Error('Duplicate prepared plan identity');
  const plans = parsed.plans?.map(item => {
    for (const step of item.steps) {
      if (step.maxTicks > pool.planTicks!) throw new Error('Prepared step exceeds the current trial duration');
      if (Math.hypot(step.target.x - pool.state.x, step.target.y - pool.state.y) > 4096) throw new Error('Prepared target is outside the local planning radius');
      if (step.target.kind !== 'point') {
        const observations = step.target.kind === 'enemy' ? pool.state.enemies : pool.state.pickups;
        if (!observations.some(actor => actor.engineType === step.target.engineType && Math.hypot(actor.position.x - step.target.x, actor.position.y - step.target.y, actor.position.z - step.target.z) < .001)) throw new Error('Prepared actor target is not an observed entity');
      } else if (step.target.engineType !== undefined) throw new Error('Point targets cannot impersonate actors');
      if ((step.kind === 'attack' || step.kind === 'strafeAttack') && step.target.kind !== 'enemy') throw new Error('Prepared attacks require an observed enemy');
    }
    return { ...item, novelty: pool.visited ? Number(!pool.visited.includes(cell({ ...pool.state, ...item.steps.at(-1)!.target }))) : undefined };
  });
  return { historyIndices: parsed.historyIndices, experienceIndices: parsed.experienceIndices, history, experience, plans, features: parsed.features };
}
