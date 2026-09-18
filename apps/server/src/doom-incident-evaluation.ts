import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { SessionContinuation } from './session.ts';
import { canonicalJson, type EvaluationComparison, type EvaluationContract, type EvaluationRun, type EvaluationScenario } from '@multiverse/gameplay-harness';
import { doomIncidentCheckpointSchema, type DoomIncidentCheckpoint } from './doom-evaluation-vms.ts';
import type { DoomEvaluationEvidence } from './doom-revision-evaluation.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';

export const stuckScenarioId = 'saved-stuck-position';

/** Instantiate a host-owned extra case without changing the original regression cases or limits. */
export function withDoomIncident(contract: EvaluationContract<DoomVmScenario>, input: DoomIncidentCheckpoint, continuation?: SessionContinuation): EvaluationContract<DoomVmScenario> {
  const incident = doomIncidentCheckpointSchema.parse(input);
  if (continuation && canonicalJson(contentRevision('doom-game-state', continuation.state)) !== canonicalJson(incident.state)) throw new Error('Incident knowledge does not match the captured game state');
  if (contract.scenarios.some(scenario => scenario.id === stuckScenarioId)) throw new Error('Reserved stuck-position scenario already exists');
  // The known problem must improve; opening cases remain non-regression checks.
  return { ...structuredClone(contract), acceptance: { ...contract.acceptance, minimumMeanGain: 0 }, scenarios: [
    { id: stuckScenarioId, seed: incident.state.version, input: { setup: [], incident, ...(continuation ? { continuation: structuredClone(continuation) } : {}),
      minimumSelectedTicks: Math.max(210, ...contract.scenarios.map(scenario => scenario.input.minimumSelectedTicks ?? 0)) } },
    ...structuredClone(contract.scenarios),
  ] };
}

/** Improving easy opening cases cannot hide failure to improve the situation that prompted review. */
export function requireDoomIncidentImprovement(report: EvaluationComparison<DoomVmScenario, DoomEvaluationEvidence>, original: EvaluationContract<DoomVmScenario>): void {
  if (!report.accepted) return;
  const incident = report.gains.find(pair => pair.scenarioId === stuckScenarioId);
  if (!incident || incident.gain <= 0 || incident.gain < original.acceptance.minimumMeanGain) {
    report.accepted = false; report.reason = 'Proposed improvement did not improve gameplay from the saved stuck position'; return;
  }
  const fixed = original.scenarios.map(scenario => report.gains.find(pair => pair.scenarioId === scenario.id));
  if (fixed.some(pair => !pair || pair.gain < -original.acceptance.maximumCaseRegression)) {
    report.accepted = false; report.reason = 'Proposed improvement did not meet the original regression comparison'; return;
  }
  report.reason = 'Improved gameplay from the saved stuck position and passed the original regression comparison';
}


/** Do not spend more runs on a candidate that has already failed its mandatory live-situation case. */
export function doomIncidentRejection(scenario: EvaluationScenario<DoomVmScenario>, runs: ReadonlyArray<EvaluationRun<DoomEvaluationEvidence>>,
  original: EvaluationContract<DoomVmScenario>): string | undefined {
  if (scenario.id !== stuckScenarioId) return;
  if (runs.length !== 2 || runs.some(run => run.status !== 'complete')) return 'Saved-position comparison did not complete; remaining test games were skipped';
  const baseline = runs.find(run => run.role === 'baseline'), candidate = runs.find(run => run.role === 'candidate');
  const before = baseline?.metrics?.[original.acceptance.metric], after = candidate?.metrics?.[original.acceptance.metric];
  if (before === undefined || after === undefined) return 'Saved-position comparison has no score; remaining test games were skipped';
  const gain = (original.acceptance.direction === 'maximize' ? 1 : -1) * (after - before);
  if (!(gain > 0 && gain >= original.acceptance.minimumMeanGain)) return 'Proposed improvement did not improve gameplay from the saved stuck position; remaining test games were skipped';
}
