import type { VersionRef } from './contracts.ts';
import type { ActivationRef, LearningRevision, RevisionCapability } from './revisions.ts';
import { canonicalJson } from './policy.ts';

/** Frozen generation origin. Submission must compare both epoch and user context. */
export interface ProposalOrigin { activation: ActivationRef; context: VersionRef }
export interface SupervisorRequest<Policy, Evidence> {
  id: string;
  origin: ProposalOrigin;
  current: LearningRevision<Policy>;
  objective: string;
  capabilities: RevisionCapability[];
  /** Contract identity only. Private acceptance scenarios need not leave the evaluator. */
  contract: VersionRef;
  task: string;
  evidence: Evidence;
  /** Host-owned schema for proposal data; the host must validate returned data again. */
  outputSchema: unknown;
}
export interface SupervisorLimits {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  /** Provider-side spending cutoff; actual usage can overshoot and must be accounted. */
  maxCostMicros: number;
}
export interface SupervisorReceipt {
  id: string;
  provider: VersionRef;
  startedAt: number;
  elapsedMs: number;
  inputBytes: number;
  outputBytes: number;
  status: 'complete' | 'failed' | 'cancelled' | 'timeout';
  requestedModel: string;
  servingModels: string[];
  /** Report tokens independently of price. An omitted price is unknown, never zero. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costMicros?: number };
  error?: string;
}
export interface SupervisorOutput { draft: unknown; receipt: SupervisorReceipt }
/** Outer improvement providers submit data. They never own evaluator, activation or game state. */
export interface SupervisorProvider<Policy, Evidence> {
  readonly version: VersionRef;
  propose(request: SupervisorRequest<Policy, Evidence>, limits: SupervisorLimits, signal: AbortSignal): Promise<SupervisorOutput>;
}
export function validateSupervisorLimits(limits: SupervisorLimits): void {
  canonicalJson(limits);
  if (Object.keys(limits).sort().join() !== 'maxCostMicros,maxInputBytes,maxOutputBytes,timeoutMs'
    || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.timeoutMs > 300_000 || limits.maxInputBytes > 1_048_576 || limits.maxOutputBytes > 1_048_576
    || limits.maxCostMicros > 100_000_000) throw new Error('Invalid supervisor limits');
}
