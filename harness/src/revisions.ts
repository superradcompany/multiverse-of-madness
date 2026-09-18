import type { VersionRef } from './contracts.ts';

/** Data and immutable executable references. The user guide/evaluator live outside this artifact. */
export interface LearningRevision<Policy> {
  revision: VersionRef;
  policy: Policy;
  prompts: Record<string, string>;
  skills: Array<{ id: string; instructions: string }>;
  executor: VersionRef;
  model: VersionRef;
  adapter: VersionRef;
}
export type RevisionCapability = 'policy' | 'prompts' | 'skills' | 'executor' | 'model' | 'adapter';
export const revisionCapabilities: readonly RevisionCapability[] = ['policy', 'prompts', 'skills', 'executor', 'model', 'adapter'];
export interface ActivationRef { revision: VersionRef; epoch: number }
export interface Qualification {
  baseline: VersionRef;
  candidate: VersionRef;
  contract: VersionRef;
  context: VersionRef;
  accepted: boolean;
  /** JSON evidence or immutable artifact references, owned by the trusted evaluator. */
  evidence: unknown;
  reason: string;
}
export type ProposalStatus = 'proposed' | 'evaluating' | 'qualified' | 'rejected' | 'failed' | 'cancelled' | 'interrupted' | 'stale' | 'expired' | 'activated';
export interface RevisionProposal {
  id: string;
  basedOn: ActivationRef;
  candidate: VersionRef;
  context: VersionRef;
  capabilities: RevisionCapability[];
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  qualification?: Qualification;
  error?: string;
}
export interface RevisionActivation {
  from: ActivationRef;
  to: ActivationRef;
  context: VersionRef;
  at: number;
  kind: 'activate' | 'rollback';
  proposalId?: string;
  reason: string;
}
export interface RevisionRules {
  /** Immutable independent evaluation contract, including scenarios, metric and total budgets. */
  contract: VersionRef;
  capabilities: RevisionCapability[];
  maxLifetimeMs: number;
}
export interface RevisionJournal<Policy> {
  version: 1;
  rules: RevisionRules;
  initial: VersionRef;
  active: ActivationRef;
  artifacts: Array<LearningRevision<Policy>>;
  proposals: RevisionProposal[];
  history: RevisionActivation[];
}
export interface QualificationRequest<Policy> {
  proposalId: string;
  baseline: LearningRevision<Policy>;
  candidate: LearningRevision<Policy>;
  contract: VersionRef;
  context: VersionRef;
}
export interface RevisionPorts<Policy> {
  /** Verify content digests, schemas and artifact existence without loading candidate code into the host. */
  verify(artifact: LearningRevision<Policy>): Promise<void>;
  /** Trusted evaluator, never supplied by a proposal. Meter and join all dispatched work on abort. */
  qualify(request: QualificationRequest<Policy>, signal: AbortSignal): Promise<Qualification>;
  /** Identity of user guide/overrides and other external decision inputs. Changes invalidate old proposals. */
  context(): VersionRef;
  /** Check whether the new adapter/executor can consume the current world state. */
  compatible(current: LearningRevision<Policy>, next: LearningRevision<Policy>): Promise<void>;
  /** Fence world decisions and context changes until publication finishes. Do not mutate another active pointer here. */
  boundary<T>(work: () => Promise<T>): Promise<T>;
  /** Atomic durable publication. A rejected acknowledgment poisons this controller until reopened from storage. */
  persist(journal: RevisionJournal<Policy>): Promise<void>;
  now?(): number;
}
