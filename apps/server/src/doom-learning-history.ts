import { canonicalJson, RevisionController, type ActivationRef, type LearningRevision, type RevisionJournal, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { decodeDoomSupervisor, type SavedDoomSupervisor } from './doom-supervisor.ts';
import type { DoomPolicy } from './doom-policy.ts';

/** Immutable lineage evidence, never an executable fallback or an active pointer. */
export interface DoomLearningHistory {
  version: 1;
  revision: VersionRef;
  lineages: SavedDoomSupervisor[];
}
export type DoomHistoricalResolver = (activation: ActivationRef) => LearningRevision<DoomPolicy> | undefined;

export function doomLearningHistory(lineages: readonly SavedDoomSupervisor[]): DoomLearningHistory {
  const fields = { version: 1 as const, lineages: structuredClone([...lineages]) };
  return { ...fields, revision: contentRevision('doom-learning-history', fields) };
}

/** Verify every journal and artifact before admitting any historical reference. No work is resumed. */
export async function verifyDoomLearningHistory(input: DoomLearningHistory,
  verify: (artifact: LearningRevision<DoomPolicy>, lineage: SavedDoomSupervisor) => Promise<void>): Promise<DoomHistoricalResolver> {
  if (input?.version !== 1 || !Array.isArray(input.lineages)
    || Object.keys(input).sort().join() !== 'lineages,revision,version'
    || canonicalJson(input.revision) !== canonicalJson(doomLearningHistory(input.lineages).revision)) throw new Error('Doom learning history content mismatch');
  const references = new Map<string, LearningRevision<DoomPolicy>>(), identities = new Set<string>();
  for (const raw of structuredClone(input.lineages)) {
    const lineage = decodeDoomSupervisor(raw), identity = canonicalJson(lineage.identity);
    if (identities.has(identity)) throw new Error('Duplicate Doom learning lineage');
    identities.add(identity);
    if (lineage.journal.proposals.some(proposal => proposal.status === 'evaluating')) throw new Error('Finish or reconcile historical evaluations before upgrading');
    const journal: RevisionJournal<DoomPolicy> = lineage.journal;
    // The shared controller checks the complete activation/qualification chain.
    // These ports cannot mutate history, execute models or launch evaluation VMs.
    const controller = await RevisionController.restore(journal, journal.rules, {
      context: () => lineage.identity,
      verify: artifact => verify(artifact, lineage),
      compatible: async () => { throw new Error('Historical learning is read-only'); },
      boundary: async () => { throw new Error('Historical learning is read-only'); },
      qualify: async () => { throw new Error('Historical learning cannot run evaluations'); },
      persist: async () => { throw new Error('Historical learning cannot be rewritten'); },
    });
    const verified = controller.snapshot();
    for (const activation of [{ epoch: 0, revision: verified.initial }, ...verified.history.map(entry => entry.to)]) {
      const artifact = verified.artifacts.find(item => canonicalJson(item.revision) === canonicalJson(activation.revision))!;
      const key = canonicalJson(activation), previous = references.get(key);
      if (previous && canonicalJson(previous) !== canonicalJson(artifact)) throw new Error('Conflicting historical Doom activation');
      references.set(key, artifact);
    }
  }
  return activation => {
    const artifact = references.get(canonicalJson(activation));
    return artifact ? structuredClone(artifact) : undefined;
  };
}
