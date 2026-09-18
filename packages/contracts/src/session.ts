import type { ActivationRef, VersionRef } from '@multiverse/gameplay-harness';
import type { GameState } from './game.ts';
import type { AiSkill } from './skills.ts';
export interface PlanView { label: string; steps: string[]; step: number; status: 'running' | 'complete' | 'replan' | 'horizon'; reason?: string }
export interface LearningProvenance { activation: ActivationRef; adapter: VersionRef; executor: VersionRef; model: VersionRef }
export interface DecisionOptionsView {
  tick: number; kind: 'plans' | 'actions'; selected: string;
  options: Array<{ id: string; label: string; steps?: string[]; evidence?: string }>;
  changes?: { tick: number; added: string[]; removed: string[]; updated: string[] };
}
export interface WorldView {
  decisionOptions?: DecisionOptionsView;
  learning?: LearningProvenance;
  policyRevision?: VersionRef;
  plan?: PlanView;
  id: string;
  parentId?: string;
  generation: number;
  role: 'main' | 'experiment' | 'archived';
  status: 'running' | 'paused' | 'ended';
  controller: 'ai' | 'human';
  label: string;
  state: GameState;
  currentAction?: string;
  thinking?: boolean;
  probability?: number;
  score?: number;
  frameVersion: number;
  trial?: { elapsed: number; total: number; healthChange: number; kills: number; distance: number };
}
export interface Commentary { id: number; worldId: string; text: string; at: number }
export interface RecoveryPolicy { enabled: boolean; maxRetries: number; healthLoss: number; stallSeconds: number }
export interface SessionView {
  skills?: AiSkill[];
  skillsRevision?: number;
  forkThreshold?: number;
  maxFutures?: number;
  /** Supervisor-requested breadth, bounded by maxFutures and available candidates. */
  effectiveFutures?: number;
  planningMode?: 'plans' | 'actions';
  stats?: { stalledSeconds?: number; kills: number; items: number; secrets: number; levels: number; seconds: number; health: number; armor: number; ammo: number[]; damage: number; healing: number; ammoSpent: number; cells: number; partial: boolean; attempts: { seconds: number; kills: number; deaths: number; rejectedBatches: number; retries: number; rollbacks: number; planFailures?: number } };
  recovery?: { policy: RecoveryPolicy; failures: number; checkpoints: Array<{ id: string; createdAt: number; tick: number; health: number; kills: number; map: string }>; message?: string };
  worlds: WorldView[];
  mainId: string;
  running: boolean;
  busy: boolean;
  stage: 'ready' | 'deciding' | 'acting' | 'forking' | 'exploring' | 'choosing' | 'continuing' | 'error';
  objective: string;
  pendingObjective?: string;
  commentary: Commentary[];
  error?: string;
  confidence?: number;
  decision?: { learning?: LearningProvenance; policyRevision?: VersionRef; routingPolicyRevision?: VersionRef; candidateCount?: number; futureLimit?: number; kind?: 'plan' | 'action'; action: string; mode: 'direct' | 'uncertain' | 'manual' | 'stalled'; threshold: number;
    preparation?: { revision: VersionRef; historyIndices: number[]; experienceIndices: number[]; features: Record<string, string | number | boolean>; planIds: string[] };
    sourceId?: string; tick?: number; latencyMs?: number; waitMs?: number; prefetched?: boolean;
    evidence?: { skills?: Array<Omit<AiSkill, "enabled">>; objective: string; stats: { current: { health: number; armor: number; mapKills: number }; route: { kills: number; gameSeconds: number; exploredCells: number }; progress: { secondsWithoutProgress: number } }; experienceUsed: number };
    perception?: { profile: 'game-aware'; blockedEnemies: number; uncertainTargets: number; forwardBarrier: number; movementFailed: boolean; excludedActions: string[] };
    preferences?: Array<{ action: string; probability: number; tested: boolean }>;
  };
  routing?: { direct: number; uncertain: number; manual: number; stalled?: number };
  experience?: { enabled: boolean; stored: number; used: number; capacity?: number; contextLimit?: number; evidence?: Array<{ action: string; ticks: number; health: number; kills: number; moved: number; died: boolean }> };
  model?: string;
  manualChoiceRequired?: boolean;
  reviewEndsAt?: number;
  winnerDelaySeconds?: number;
  decisionIntervalTicks?: number;
  decisionIntervalMode?: 'fixed' | 'trial';
  trialDurationTicks?: number;
  directorWorldIds?: string[];
  comparison?: { candidateIds: string[]; bestId: string; reason: string; selected: boolean };
}
