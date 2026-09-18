import type { EvaluationContract, LearningRevision } from '@multiverse/gameplay-harness';
import { cappedLearningDoomPolicy, type DoomPolicy } from './doom-policy.ts';
import type { DoomEvaluationContext } from './doom-revision-evaluation.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';

/** Opt-in host rule. Historical contracts without it retain their fixed allowances. */
export interface DoomEvaluationContract extends EvaluationContract<DoomVmScenario> {
  allowance?: 'complete-futures-v1';
}

/** Instantiate one common allowance before either side runs. No observed result can alter it. */
export function withDoomEvaluationAllowance(template: DoomEvaluationContract,
  baseline: LearningRevision<DoomPolicy>, candidate: LearningRevision<DoomPolicy>, context: DoomEvaluationContext): DoomEvaluationContract {
  const contract = structuredClone(template);
  if (contract.allowance === undefined) return contract;
  if (contract.allowance !== 'complete-futures-v1') throw new Error('Unsupported Doom evaluation allowance rule');
  const cap = context.maximumFutures ?? context.overrides.breadth ?? baseline.policy.breadth;
  const policies = [baseline, candidate].map(artifact => cappedLearningDoomPolicy(artifact, context.overrides, cap).policy.values);
  const coverage = Math.max(1, ...contract.scenarios.map(scenario => scenario.input.minimumSelectedTicks ?? 0));
  const setup = Math.max(0, ...contract.scenarios.map(scenario =>
    (scenario.input.incident ? 0 : 35) + scenario.input.setup.reduce((ticks, step) => ticks + step.ticks, 0)));
  const requirements = policies.map(policy => {
    const batches = Math.ceil(coverage / policy.trialTicks);
    const cadence = policy.decisionIntervalMode === 'trial' ? policy.trialTicks : Math.min(policy.trialTicks, policy.decisionTicks);
    return {
      // Also cover a direct action whose configured hold exceeds the trial horizon.
      simulation: setup + policy.breadth * Math.max(batches * policy.trialTicks, policy.decisionTicks),
      // The parent judgment seeds every future; only later decisions are per child.
      calls: batches * (1 + policy.breadth * Math.max(0, Math.ceil(policy.trialTicks / cadence) - 1)),
    };
  });
  const original = template.budget.limits;
  const simulation = Math.max(original.simulation ?? 0, ...requirements.map(value => value.simulation));
  const modelCalls = Math.max(original.modelCalls ?? 0, ...requirements.map(value => value.calls));
  const executorCalls = Math.max(original.executorCalls ?? 0, ...requirements.map(value => value.calls));
  const scale = Math.max(1, simulation / Math.max(1, original.simulation ?? simulation),
    modelCalls / Math.max(1, original.modelCalls ?? modelCalls), executorCalls / Math.max(1, original.executorCalls ?? executorCalls));
  contract.budget.limits = { ...original, simulation, modelCalls, executorCalls };
  contract.maxRunMs = Math.ceil(template.maxRunMs * scale);
  return contract;
}
