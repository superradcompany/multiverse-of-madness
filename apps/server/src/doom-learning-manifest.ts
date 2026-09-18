import { canonicalJson, type ExecutorLimits, type LearningRevision, type SupervisorLimits, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { VmResources } from '../../../packages/contracts/src/vm.ts';
import type { DoomLearningBuild } from './doom-learning-build.ts';
import type { DoomPolicy } from './doom-policy.ts';
import type { DoomEvaluationContract } from './doom-evaluation-allowance.ts';

export interface DoomLearningManifest {
  version: 1 | 2;
  revision: VersionRef;
  build: DoomLearningBuild;
  profile: 'game-aware';
  image: string;
  resources: VmResources;
  initial: LearningRevision<DoomPolicy>;
  contract: DoomEvaluationContract;
  generationBudget: { simulationUnit: string; limits: { supervisorCalls: number; costMicros: number } };
  liveBudget: { simulationUnit: string; limits: { modelCalls: number; executorCalls: number } };
  proposalLimits: SupervisorLimits;
  executorLimits: ExecutorLimits;
  /** Format 2 pins the complete read-only history inherited at a build upgrade. */
  history?: VersionRef;
}
export function decodeDoomLearningManifest(value: unknown): DoomLearningManifest {
  if (!value || typeof value !== 'object' || !('version' in value) || ![1, 2].includes(value.version as number)) throw new Error('Unsupported learning service manifest');
  const { revision, ...fields } = value as DoomLearningManifest;
  if (canonicalJson(revision) !== canonicalJson(contentRevision('doom-learning-service', fields))) throw new Error('Learning service manifest content mismatch');
  if ((fields.version === 2) !== Boolean(fields.history)) throw new Error('Invalid learning history manifest version');
  return value as DoomLearningManifest;
}
