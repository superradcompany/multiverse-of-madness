import { z } from 'zod';
import { stuckScenarioId } from './doom-incident-evaluation.ts';

const position = z.object({ x: z.number(), y: z.number(), z: z.number(), episode: z.number(), map: z.number() });
const plan = z.object({ label: z.string(), status: z.string(), step: z.number(), reason: z.string().optional() });
const failure = z.object({ feedback: z.object({ label: z.string(), reason: z.string().optional(), step: z.number(),
  target: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }) });
const attempts = z.object({ seconds: z.number().nonnegative(), deaths: z.number().int().nonnegative(),
  rejectedBatches: z.number().int().nonnegative(), retries: z.number().int().nonnegative(), rollbacks: z.number().int().nonnegative() });
const stats = z.object({ seconds: z.number().nonnegative(), attempts: attempts.optional() });
const runSchema = z.object({ scenarioId: z.literal(stuckScenarioId), role: z.enum(['baseline', 'candidate']), status: z.string(),
  metrics: z.record(z.string(), z.number()).optional(),
  evidence: z.object({ initial: position, final: position,
    initialStats: stats.optional(),
    session: z.object({ mainId: z.string(), worlds: z.array(z.object({ id: z.string(), plan: plan.optional() })), stats: stats.optional(),
      recovery: z.object({ failures: z.number().int().nonnegative(), message: z.string().optional() }).optional() }),
    decisions: z.array(z.object({ decision: z.object({ action: z.string(), plans: z.object({ selected: z.string(), candidates: z.array(z.object({ id: z.string(), label: z.string() })) }).optional() }) })),
    planFailures: z.array(failure).optional(),
  }).optional(),
});
const metricNames = ['score', 'cells', 'kills', 'items', 'secrets', 'damage', 'health', 'gameSeconds', 'exited', 'alive'];

/** Public incident evidence only. Never reveal private regression scenarios or their observations. */
export function doomIncidentFeedback(value: unknown) {
  const parsed = z.object({ runs: z.array(z.unknown()) }).safeParse(value);
  if (!parsed.success) return;
  const runs = parsed.data.runs.flatMap(value => {
    const parsed = runSchema.safeParse(value); if (!parsed.success) return [];
    const { role, status, metrics, evidence } = parsed.data;
    const choices = new Map<string, number>();
    for (const { decision } of evidence?.decisions ?? []) {
      const label = (decision.plans?.candidates.find(plan => plan.id === decision.plans!.selected)?.label ?? decision.action).slice(0, 120);
      choices.set(label, (choices.get(label) ?? 0) + 1);
    }
    return [{ role, status, metrics: metrics ? Object.fromEntries(metricNames.flatMap(name => metrics[name] === undefined ? [] : [[name, metrics[name]]])) : undefined,
      start: evidence?.initial, end: evidence?.final,
      selectedGameSeconds: evidence?.session.stats ? Math.max(0, evidence.session.stats.seconds - (evidence.initialStats?.seconds ?? 0)) : undefined,
      trialWork: evidence?.session.stats?.attempts ? Object.fromEntries(Object.entries(evidence.session.stats.attempts)
        .map(([key, value]) => [key, Math.max(0, value - (evidence.initialStats?.attempts?.[key as keyof z.infer<typeof attempts>] ?? 0))])) : undefined,
      recovery: evidence?.session.recovery ? { failures: evidence.session.recovery.failures, message: evidence.session.recovery.message?.slice(0, 500) } : undefined,
      lastSelectedPlan: evidence?.session.worlds.find(world => world.id === evidence.session.mainId)?.plan,
      choicesAcrossTrialFutures: [...choices].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, decisions]) => ({ label, decisions })),
      recentStops: evidence?.planFailures?.slice(-6).map(({ feedback }) => feedback) }];
  });
  if (!runs.length) return;
  return { scope: 'Observed outcomes from the saved situation that prompted this proposal. Choice counts and trialWork include discarded futures; selectedGameSeconds counts only committed play. Error runs are incomplete observations, not qualified scores. Recovery can reject a completed batch and retry without committing it. These are observations, not causal explanations.', runs };
}
