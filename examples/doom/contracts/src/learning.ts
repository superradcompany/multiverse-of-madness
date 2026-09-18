import type { ActivationRef, RevisionActivation, RevisionCapability, VersionRef } from '@multiverse/gameplay-harness';

export type SupervisorCli = 'codex' | 'claude';
export const learningProposalKinds = ['guidance', 'planner', 'executor'] as const;
export type LearningProposalKind = typeof learningProposalKinds[number];

export interface LearningJobView {
  id: string; provider?: SupervisorCli; kind: 'propose' | 'evaluate'; proposalId?: string; status: string; outcome?: string; error?: string; createdAt: number;
  /** Checkpoint capture may be waiting for gameplay to reach a safe boundary; no generation has started. */
  preparingCheckpoint?: boolean;
}
export interface LearningProposalView {
  id: string; status: string; reason: string; changed: RevisionCapability[]; createdAt: number;
  revision: VersionRef; canEvaluate: boolean; canActivate: boolean; stale: boolean;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  result?: { accepted: boolean; reason: string; meanGain?: number; cases: number; regressedCases: number };
  error?: string;
}
export interface LearningView {
  automation?: { enabled: boolean; provider: SupervisorCli; error?: string;
    cycle?: { proposalId: string; evaluationId: string; reason: string };
    lastOutcome?: { proposalId: string; status: string; reason?: string } };
  defaultProvider: SupervisorCli; providers: SupervisorCli[];
  enabled: boolean; busy: boolean; canEnable: boolean; boundaryReason?: string;
  active?: ActivationRef; history: RevisionActivation[]; jobs: LearningJobView[]; proposals: LearningProposalView[];
  budget: { inputTokens?: number; outputTokens?: number; unknownTokenCalls?: number;
    proposalCalls: number; proposalCallLimit: number | null; costMicros: number; costLimitMicros: number | null; perProposalCostMicros: number | null; unknownCostCalls: number;
    liveModelCalls: number; liveModelCallLimit: number | null; liveExecutorCalls: number; liveExecutorCallLimit: number | null };
  evaluation: { cases: number; ticksPerRun: number; modelCallsPerRun: number; executorCallsPerRun: number; minimumSelectedTicks: number; maxRunSeconds: number };
}
export interface LearningProposalDetail {
  sources: Array<{ role: 'baseline' | 'candidate'; entrypoint: string; files: Record<string, string> }>;
  servingModels?: string[];
  provider?: SupervisorCli;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costMicros?: number };
}

/** Small polling payload; proposal source, history and usage stay in the diagnostic API. */
export interface ActiveStrategyView {
  activation: ActivationRef;
  planner: boolean;
  guidance: Array<{ slot: string; text: string }>;
  skills: Array<{ id: string; instructions: string }>;
  reason?: string;
  previousGuidance?: Array<{ slot: string; text: string }>;
}
export interface BackgroundLearningView {
  strategy?: ActiveStrategyView;
  ready: boolean;
  enabled: boolean;
  provider: SupervisorCli;
  proposalId?: string;
  reason?: string;
  result?: { status: string; reason?: string };
  stage: 'waiting' | 'unavailable' | 'paused' | 'watching' | 'reviewing' | 'testing' | 'applying';
  error?: string;
}
