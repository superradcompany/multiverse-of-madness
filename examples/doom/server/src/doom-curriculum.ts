import { canonicalJson, selectedTrainingScenarios, trainingMenu, type EvaluationContract, type TrainingCatalog, type TrainingSelection } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { DoomEvaluationContract } from './doom-evaluation-allowance.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';

/** Public opening exercises, never the private acceptance cases or live incident checkpoint. */
export function doomTrainingCatalog(acceptance: EvaluationContract<DoomVmScenario>): TrainingCatalog<DoomVmScenario> {
  const exercises: Array<{ id: string; label: string; description: string; input: DoomVmScenario }> = [
    { id: 'opening', label: 'Fresh opening', description: 'Choose initial movement and combat priorities from a fresh game.', input: { setup: [], minimumSelectedTicks: 210 } },
    { id: 'left-facing', label: 'Opening facing left', description: 'Recover orientation after a short left turn, then make progress.', input: { setup: [{ ticks: 14, inputs: ['left'] }], minimumSelectedTicks: 210 } },
    { id: 'right-facing', label: 'Opening facing right', description: 'Recover orientation after a short right turn, then make progress.', input: { setup: [{ ticks: 14, inputs: ['right'] }], minimumSelectedTicks: 210 } },
  ];
  const privateSetups = new Set(acceptance.scenarios.filter(scenario => !scenario.input.incident).map(scenario => canonicalJson(scenario.input.setup)));
  const scenarios = exercises.filter(exercise => !privateSetups.has(canonicalJson(exercise.input.setup)))
    .map(exercise => ({ ...exercise, seed: 'doom-initial-rng' }));
  const fields = { format: 1 as const, maximumSelection: Math.min(2, scenarios.length), scenarios };
  return { ...fields, revision: contentRevision('doom-training-catalog', fields) };
}

/** Host-owned duration, allowances and measurement. Practice never changes the acceptance contract. */
export function doomTrainingContract(acceptance: DoomEvaluationContract, selection: TrainingSelection): DoomEvaluationContract {
  const catalog = doomTrainingCatalog(acceptance);
  trainingMenu(catalog);
  return { id: 'doom-practice-' + contentRevision('selection', selection).version.slice(7), evaluator: acceptance.evaluator,
    allowance: 'complete-futures-v1', scenarios: selectedTrainingScenarios(catalog, selection),
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: 245, modelCalls: 8, executorCalls: 8 } }, maxRunMs: 180000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 0, maximumCaseRegression: 0 } };
}

export interface DoomTrainingFeedback {
  purpose: 'practice'; reason: string;
  results: Array<{ scenarioId: string; complete: boolean; gain?: number }>;
}
