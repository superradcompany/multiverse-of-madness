import { canonicalJson, type ActivationRef, type DecisionModel, type LearningRevision, type RevisionController, type VersionRef } from '@multiverse/gameplay-harness';
import type { ChessExperience, ChessPlan } from './adapter.ts';
import type { ChessState } from './runtime.ts';
import type { ChessPolicy, ChessProvenance } from './session-types.ts';
import type { ChessDecisionRequest } from './preparation.ts';
import { resolveChessPolicy } from './policy.ts';

export interface ChessDecisionModel extends DecisionModel<ChessState, ChessPlan, ChessExperience> {
  /** Optional isolated preparation. Implementations must preserve engine facts, user goal and revision. */
  prepare?(request: ChessDecisionRequest, signal: AbortSignal): Promise<ChessDecisionRequest>;
}
export interface ChessLearningBinding {
  /** Stable identity of the separately durable supervisor journal, not its current active revision. */
  readonly identity: VersionRef;
  current(): { activation: ActivationRef; artifact: LearningRevision<ChessPolicy> };
  /** Only return artifacts that were actually active at this epoch. */
  resolve(activation: ActivationRef): LearningRevision<ChessPolicy>;
  /** The host must consume this artifact's prompts/skills and isolate executable sources. */
  model(artifact: LearningRevision<ChessPolicy>): ChessDecisionModel;
}

/** Connect the public controller without copying its active pointer into a second store. */
export function chessLearningBinding(controller: RevisionController<ChessPolicy>, identity: VersionRef,
  model: ChessLearningBinding['model']): ChessLearningBinding {
  return {
    identity: Object.freeze(structuredClone(identity)), model,
    current: () => ({ activation: controller.active, artifact: controller.current }),
    resolve: activation => {
      const journal = controller.snapshot();
      const known = activation.epoch === 0 ? { revision: journal.initial, epoch: 0 } : journal.history[activation.epoch - 1]?.to;
      if (!same(known, activation)) throw new Error('Unknown chess learning activation');
      const artifact = journal.artifacts.find(item => same(item.revision, activation.revision));
      if (!artifact) throw new Error('Missing chess learning artifact');
      return artifact;
    },
  };
}
export function chessLearningProvenance(activation: ActivationRef, artifact: LearningRevision<ChessPolicy>, adapter: VersionRef): ChessProvenance {
  if (!same(activation.revision, artifact.revision) || !same(adapter, artifact.adapter)) throw new Error('Incompatible chess learning artifact');
  return { adapter: artifact.adapter, model: artifact.model, policy: resolveChessPolicy(artifact.policy).revision,
    executor: artifact.executor, learning: activation };
}
function same(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b); }
