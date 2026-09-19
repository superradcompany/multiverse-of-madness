import { canonicalJson, selectedTrainingScenarios, trainingMenu, type EvaluationContract, type TrainingCatalog, type TrainingSelection } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { DoomEvaluationContract } from './doom-evaluation-allowance.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';
import type { DoomPracticeSituation } from './doom-learning-incidents.ts';
import { sessionContinuation, type SessionCheckpoint } from './session.ts';
import { doomIncidentCheckpointSchema } from './doom-evaluation-vms.ts';
import { activeSkills } from '../../contracts/src/skills.ts';

/** Observed checkpoints and public openings; private test inputs and the current incident stay excluded. */
export function doomTrainingCatalog(acceptance: EvaluationContract<DoomVmScenario>, observed: readonly DoomPracticeSituation[] = [], current?: SessionCheckpoint): TrainingCatalog<DoomVmScenario> {
  const exercises: Array<{ id: string; label: string; description: string; input: DoomVmScenario }> = [
    { id: 'opening', label: 'Fresh opening', description: 'Choose initial movement and combat priorities from a fresh game.', input: { setup: [], minimumSelectedTicks: 210 } },
    { id: 'left-facing', label: 'Opening facing left', description: 'Recover orientation after a short left turn, then make progress.', input: { setup: [{ ticks: 14, inputs: ['left'] }], minimumSelectedTicks: 210 } },
    { id: 'right-facing', label: 'Opening facing right', description: 'Recover orientation after a short right turn, then make progress.', input: { setup: [{ ticks: 14, inputs: ['right'] }], minimumSelectedTicks: 210 } },
  ];
  const privateSetups = new Set(acceptance.scenarios.filter(scenario => !scenario.input.incident).map(scenario => canonicalJson(scenario.input.setup)));
  const scenarios = exercises.filter(exercise => !privateSetups.has(canonicalJson(exercise.input.setup)))
    .map(exercise => ({ ...exercise, seed: 'doom-initial-rng' }));
  if (observed.length && !current) throw new Error('Observed practice requires the current user context');
  const excluded = new Set(acceptance.scenarios.flatMap(scenario => scenario.input.incident ? [scenario.input.incident.state.version] : []));
  if (current) excluded.add(contentRevision('doom-game-state', sessionContinuation(current).state).version);
  const retained: typeof scenarios = [];
  for (const situation of observed) {
    const { snapshot, evidence } = situation;
    if (excluded.has(snapshot.state.version) || canonicalJson(practiceContext(evidence)) !== canonicalJson(practiceContext(current!))) continue;
    const continuation = sessionContinuation(evidence), state = continuation.state;
    if (!state.alive || state.phase !== 'level') continue;
    if (canonicalJson(snapshot.state) !== canonicalJson(contentRevision('doom-game-state', state))) throw new Error('Observed practice state differs from its checkpoint');
    excluded.add(snapshot.state.version);
    retained.push({ id: 'observed-' + snapshot.state.version.slice(7), seed: snapshot.state.version,
      label: `Observed E${state.episode}M${state.map} at ${(state.tick / 35).toFixed(1)}s`,
      description: `${state.health} health, ${state.kills} map kills, ${state.enemies.length} observed enemies. Position (${Math.round(state.x)}, ${Math.round(state.y)}, ${Math.round(state.z)}), facing ${Math.round(state.angle)} degrees. Retry with its recorded history.`,
      input: { setup: [], minimumSelectedTicks: 210, incident: structuredClone(snapshot), continuation } });
    if (retained.length === 4) break;
  }
  scenarios.unshift(...retained);
  const fields = { format: 1 as const, maximumSelection: Math.min(2, scenarios.length), scenarios };
  return { ...fields, revision: contentRevision('doom-training-catalog', fields) };
}

/** Host-owned duration, allowances and measurement. Practice never changes the acceptance contract. */
export function doomTrainingContract(acceptance: DoomEvaluationContract, selection: TrainingSelection, catalog = doomTrainingCatalog(acceptance)): DoomEvaluationContract {
  validateDoomTrainingCatalog(catalog);
  const scenarios = selectedTrainingScenarios(catalog, selection);
  if (scenarios.some(scenario => acceptance.scenarios.some(test => scenario.input.incident
    ? test.input.incident?.state.version === scenario.input.incident.state.version
    : !test.input.incident && canonicalJson(test.input.setup) === canonicalJson(scenario.input.setup)))) throw new Error('Practice cannot select an acceptance starting state');
  return { id: 'doom-practice-' + contentRevision('selection', selection).version.slice(7), evaluator: acceptance.evaluator,
    allowance: 'complete-futures-v1', scenarios,
    budget: { simulationUnit: 'doom-ticks', limits: { simulation: 245, modelCalls: 8, executorCalls: 8 } }, maxRunMs: 180000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 0, maximumCaseRegression: 0 } };
}

/** Full inputs are stored only by the host; the provider sees the content identity and public menu. */
export function validateDoomTrainingCatalog(catalog: TrainingCatalog<DoomVmScenario>): void {
  trainingMenu(catalog);
  const { revision, ...fields } = catalog;
  if (canonicalJson(revision) !== canonicalJson(contentRevision('doom-training-catalog', fields))) throw new Error('Doom practice catalog content changed');
  for (const { input } of catalog.scenarios) if (input.incident) {
    doomIncidentCheckpointSchema.parse(input.incident);
    if (input.setup.length || !input.continuation || canonicalJson(input.incident.state) !== canonicalJson(contentRevision('doom-game-state', input.continuation.state))) throw new Error('Practice knowledge does not match the captured game state');
  }
}

function practiceContext(saved: SessionCheckpoint) {
  return { objective: saved.view.pendingObjective ?? saved.view.objective, skills: activeSkills(saved.view.skills ?? []),
    binding: saved.learning?.binding ?? null, overrides: saved.learning?.overrides ?? {} };
}

export interface DoomTrainingFeedback {
  purpose: 'practice'; reason: string;
  results: Array<{ scenarioId: string; complete: boolean; gain?: number }>;
}
