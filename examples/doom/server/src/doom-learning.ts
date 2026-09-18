import { canonicalJson, type ActivationRef, type LearningRevision, type PolicyPatch, type RevisionController, type VersionRef } from '@multiverse/gameplay-harness';
import type { LearningProvenance } from '../../contracts/src/session.ts';
import type { DecisionMaker } from './jev.ts';
import type { DoomPolicy } from './doom-policy.ts';
import type { DoomHistoricalResolver } from './doom-learning-history.ts';

export interface SavedDoomLearning { binding: VersionRef; overrides: PolicyPatch<DoomPolicy> }
export interface DoomLearningBinding {
  readonly identity: VersionRef;
  readonly adapter: VersionRef;
  current(): { activation: ActivationRef; artifact: LearningRevision<DoomPolicy> };
  resolve(activation: ActivationRef): LearningRevision<DoomPolicy>;
  /** Consume this exact artifact, including prompts/skills; isolate executable source off-host. */
  model(artifact: LearningRevision<DoomPolicy>): DecisionMaker;
}

/** The controller journal owns the sole active pointer. Sessions retain historical input provenance. */
export function doomLearningBinding(controller: RevisionController<DoomPolicy>, identity: VersionRef,
  model: DoomLearningBinding['model'], historical?: DoomHistoricalResolver): DoomLearningBinding {
  return {
    identity: Object.freeze(structuredClone(identity)), adapter: Object.freeze(structuredClone(controller.current.adapter)), model,
    current: () => ({ activation: controller.active, artifact: controller.current }),
    resolve: activation => {
      const journal = controller.snapshot();
      const known = activation.epoch === 0 ? { revision: journal.initial, epoch: 0 } : journal.history[activation.epoch - 1]?.to;
      if (!same(known, activation)) {
        const archived = historical?.(activation);
        if (archived) return archived;
        throw new Error('Unknown Doom learning activation');
      }
      const artifact = journal.artifacts.find(item => same(item.revision, activation.revision));
      if (!artifact) throw new Error('Missing Doom learning artifact');
      return artifact;
    },
  };
}

export function doomLearningProvenance(binding: DoomLearningBinding, activation: ActivationRef,
  artifact = binding.resolve(activation)): LearningProvenance {
  if (!same(activation.revision, artifact.revision) || !same(binding.resolve(activation), artifact)) throw new Error('Incompatible Doom learning artifact');
  return { activation: structuredClone(activation), adapter: artifact.adapter, executor: artifact.executor, model: artifact.model };
}

export function verifyDoomLearning(binding: DoomLearningBinding | undefined, reference: LearningProvenance): void {
  if (!binding || !same(reference, doomLearningProvenance(binding, reference.activation))) throw new Error('Saved Doom learning provenance does not match its active artifact');
}
function same(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b); }
