import { canonicalJson, resolvePolicy, type LearningRevision, type PolicyPatch, type PolicyLayer, type PolicySchema, type ReadonlyValue, type ResolvedPolicy } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { z } from 'zod';
import { doomOutcomeWeightsSchema } from './doom-outcome.ts';

const settings = z.strictObject({
  outcomeWeights: doomOutcomeWeightsSchema.optional(),
  forkThreshold: z.number().min(0).max(1),
  breadth: z.number().int().min(1).max(10),
  trialTicks: z.number().int().positive(),
  decisionTicks: z.number().int().positive(),
  decisionIntervalMode: z.enum(['fixed', 'trial']).optional(),
  planningMode: z.enum(['plans', 'actions']),
  winnerDelaySeconds: z.number().min(0).max(60),
  memory: z.strictObject({ enabled: z.boolean(), capacity: z.number().int().min(8).max(1024), perDecision: z.number().int().min(1).max(8) }),
  recovery: z.strictObject({ enabled: z.boolean(), maxRetries: z.number().int().min(0).max(10), healthLoss: z.number().min(1).max(100), stallSeconds: z.number().min(5).max(120) }),
});
export type DoomPolicy = z.infer<typeof settings>;
const schema: PolicySchema<DoomPolicy> = {
  version: { id: 'doom-policy', version: '1' },
  defaults: { forkThreshold: 0.75, breadth: 4, trialTicks: 210, decisionTicks: 35, planningMode: 'plans', winnerDelaySeconds: 0,
    memory: { enabled: false, capacity: 128, perDecision: 2 }, recovery: { enabled: false, maxRetries: 2, healthLoss: 15, stallSeconds: 15 } },
  parse: value => settings.parse(value),
};
export type DoomPolicyRecord = { revision: ReturnType<typeof contentRevision>; policy: ReadonlyValue<ResolvedPolicy<DoomPolicy>> };

/** Supervisor policy stays inside the application's bounded controls. The guide is not policy. */
export const doomLearningPolicySchema = settings.extend({ breadth: z.number().int().min(2).max(10), trialTicks: z.number().int().min(1).max(2100),
    decisionTicks: z.number().int().min(1).max(2100),
    recovery: settings.shape.recovery.extend({ healthLoss: z.number().int().min(1).max(100), stallSeconds: z.number().int().min(5).max(120) }),
  });
export function parseDoomLearningPolicy(value: unknown): DoomPolicy { return doomLearningPolicySchema.parse(value); }

/** A verified learning artifact is the profile; explicit user edits always apply last. */
export function learningDoomPolicy(artifact: LearningRevision<DoomPolicy>, overrides: PolicyPatch<DoomPolicy>): DoomPolicyRecord {
  const policy = resolvePolicy({ ...schema, parse: parseDoomLearningPolicy }, {
    adapter: { revision: { id: 'doom-clock', version: '35-ticks-per-second-v1' }, patch: {} },
    profile: { revision: artifact.revision, patch: parseDoomLearningPolicy(artifact.policy) },
    session: { revision: contentRevision('doom-user-overrides', overrides), patch: overrides },
  });
  return { revision: contentRevision('doom-policy', policy), policy };
}

/** Breadth is supervisor-controlled beneath the user's resource ceiling. Historical overrides retain their recorded shape. */
export function cappedLearningDoomPolicy(artifact: LearningRevision<DoomPolicy>, overrides: PolicyPatch<DoomPolicy>, cap: number): DoomPolicyRecord {
  if (!Number.isInteger(cap) || cap < 2 || cap > 10) throw new Error('Maximum futures must be 2–10');
  return learningDoomPolicy(artifact, { ...overrides, breadth: Math.min(artifact.policy.breadth, cap) });
}

/** The existing interactive controls remain authoritative, now with explicit provenance. */
export function doomPolicy(profile: Pick<DoomPolicy, 'forkThreshold' | 'breadth' | 'trialTicks'>, session: DoomPolicy): DoomPolicyRecord {
  const policy = resolvePolicy(schema, {
    adapter: { revision: { id: 'doom-clock', version: '35-ticks-per-second-v1' }, patch: {} },
    profile: { revision: contentRevision('doom-session-options', profile), patch: profile },
    session: { revision: contentRevision('doom-session-controls', session), patch: session },
  });
  return { revision: contentRevision('doom-policy', policy), policy };
}

/** Verify the persisted catalogue instead of trusting a label for changed content. */
export function restoreDoomPolicy(record: DoomPolicyRecord): DoomPolicyRecord {
  const saved = record?.policy;
  if (!saved || canonicalJson(saved.schema) !== canonicalJson(schema.version)
    || saved.layers.length !== 4 || saved.layers.map(layer => layer.name).join() !== 'defaults,adapter,profile,session') throw new Error('Unsupported Doom policy revision');
  const layers: Partial<Record<'adapter' | 'profile' | 'session', PolicyLayer<DoomPolicy>>> = {};
  for (const layer of saved.layers.slice(1)) layers[layer.name as keyof typeof layers] = structuredClone(layer) as PolicyLayer<DoomPolicy>;
  const policy = resolvePolicy(schema, layers);
  const revision = contentRevision('doom-policy', policy);
  if (canonicalJson(saved) !== canonicalJson(policy) || canonicalJson(record.revision) !== canonicalJson(revision)) throw new Error('Doom policy content does not match its revision');
  return { revision, policy };
}
