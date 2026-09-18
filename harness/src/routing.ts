export type DecisionRoute = 'direct' | 'uncertain' | 'stalled' | 'manual';
export interface RoutingPolicy {
  threshold: number;
  breadth: number;
}
export interface RoutingContext {
  confidence: number;
  manual: boolean;
  stalled: boolean;
  retries: number;
}
export interface WeightedCandidate { probability: number }

/** Route on explicit triggers; confidence is a model signal, not an outcome score. */
export function routeDecision<T extends WeightedCandidate>(candidates: readonly T[], policy: RoutingPolicy, context: RoutingContext): {
  mode: DecisionRoute;
  ranked: T[];
  trials: T[];
} {
  probability(policy.threshold, 'Fork threshold');
  probability(context.confidence, 'Decision confidence');
  if (!Number.isSafeInteger(policy.breadth) || policy.breadth < 1) throw new Error('Trial breadth must be a positive integer');
  if (!Number.isSafeInteger(context.retries) || context.retries < 0) throw new Error('Retry count must be a nonnegative integer');
  if (!candidates.length) throw new Error('No eligible candidates are available');
  for (const candidate of candidates) probability(candidate.probability, 'Candidate probability');
  const mode = context.manual ? 'manual' : context.stalled ? 'stalled' : context.confidence < policy.threshold ? 'uncertain' : 'direct';
  const ranked = [...candidates].sort((a, b) => b.probability - a.probability);
  if (mode === 'direct') return { mode, ranked, trials: [] };
  // Rotate by whole comparison batches so retries explore other eligible choices.
  const offset = Number((BigInt(context.retries) * BigInt(policy.breadth)) % BigInt(ranked.length));
  const trials = [...ranked.slice(offset), ...ranked.slice(0, offset)].slice(0, policy.breadth);
  return { mode, ranked, trials };
}
function probability(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be between zero and one`);
}
