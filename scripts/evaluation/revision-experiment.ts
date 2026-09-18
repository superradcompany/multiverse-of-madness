import { join } from 'node:path';
import { RevisionController, SerialQueue, canonicalJson, type EvaluationComparison, type LearningRevision, type RevisionJournal, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';

/** Host-owned evaluation wiring for an isolated, idle experiment. It does not control the live server. */
export async function revisionExperiment<Policy, Input, Evidence>(options: {
  directory: string;
  baseline: LearningRevision<Policy>;
  candidate: LearningRevision<Policy>;
  contract: VersionRef;
  context: VersionRef;
  evaluate(signal: AbortSignal): Promise<EvaluationComparison<Input, Evidence>>;
}, signal: AbortSignal): Promise<EvaluationComparison<Input, Evidence>> {
  const journal = new JsonFileStore(join(options.directory, 'supervisor.json'), value => value as RevisionJournal<Policy>);
  const comparisons = new JsonFileStore(join(options.directory, 'comparison.json'), value => value as EvaluationComparison<Input, Evidence>);
  const boundary = new SerialQueue();
  let report: EvaluationComparison<Input, Evidence> | undefined;
  const rules = { contract: options.contract, capabilities: ['policy'] as const, maxLifetimeMs: 3_600_000 };
  const limits = { ...rules, capabilities: [...rules.capabilities] };
  const ports: Parameters<typeof RevisionController.create<Policy>>[2] = {
    // Only the two exact source/profile manifests captured by this host are eligible.
    verify: async artifact => {
      const { revision, ...data } = artifact;
      if (canonicalJson(revision) !== canonicalJson(contentRevision(revision.id, data))) throw new Error('Learning artifact digest mismatch');
      if (![options.baseline, options.candidate].some(item => canonicalJson(item) === canonicalJson(artifact))) throw new Error('Unknown learning artifact');
    },
    context: () => options.context,
    compatible: async (before, after) => {
      for (const key of ['adapter', 'executor', 'model'] as const) if (canonicalJson(before[key]) !== canonicalJson(after[key])) throw new Error('This experiment only qualifies policy changes');
    },
    boundary: work => boundary.run(work),
    persist: snapshot => journal.save(snapshot),
    qualify: async (request, current) => {
      report = await options.evaluate(current);
      if (canonicalJson(request.baseline.revision) !== canonicalJson(report.baseline) || canonicalJson(request.candidate.revision) !== canonicalJson(report.candidate)
        || canonicalJson(contentRevision(request.contract.id, report.contract)) !== canonicalJson(request.contract)) throw new Error('Evaluation returned a different experiment');
      await comparisons.save(report);
      return { baseline: report.baseline, candidate: report.candidate, contract: request.contract, context: request.context,
        accepted: report.accepted, reason: report.reason, evidence: { comparison: contentRevision('comparison', report) } };
    },
  };
  const controller = await RevisionController.create(options.baseline, limits, ports);
  await controller.submit({ id: 'policy-experiment', candidate: options.candidate, reason: 'Compare the proposed search policy under the fixed total budget', expiresAt: Date.now() + limits.maxLifetimeMs });
  const evaluated = await controller.evaluate('policy-experiment', signal);
  if (evaluated.status === 'qualified') await controller.activate(evaluated.id);
  await controller.join(); await journal.flush();
  // Restore from disk, not from the controller's in-memory state, before exposing the active profile.
  const reopened = await RevisionController.restore((await journal.load())!, limits, ports);
  if (canonicalJson(reopened.snapshot()) !== canonicalJson(controller.snapshot())) throw new Error('Supervisor history changed during restart');
  await new JsonFileStore(join(options.directory, 'active-profile.json'), value => value).save({ activation: reopened.active, artifact: reopened.current });
  if (!report) throw new Error(evaluated.error ?? `Experiment ended without a comparison: ${evaluated.status}`);
  return report;
}
