import type { VersionRef } from './contracts.ts';
import type { EvaluationScenario } from './evaluation.ts';
import { canonicalJson } from './policy.ts';

/** Host-authored practice cases. Independent acceptance cases must never enter this catalog. */
export interface TrainingCatalog<Input> {
  format: 1;
  revision: VersionRef;
  maximumSelection: number;
  scenarios: Array<EvaluationScenario<Input> & { label: string; description: string }>;
}
/** The supervisor may choose practice cases, not supply inputs, seeds, budgets or grading rules. */
export interface TrainingSelection { catalog: VersionRef; scenarioIds: string[]; reason: string }
export interface TrainingMenu {
  catalog: VersionRef;
  maximumSelection: number;
  scenarios: Array<{ id: string; label: string; description: string }>;
}

/** Compact public menu; execution payloads and seeds stay with the host. */
export function trainingMenu<Input>(catalog: TrainingCatalog<Input>): TrainingMenu {
  validateCatalog(catalog);
  return { catalog: { ...catalog.revision }, maximumSelection: catalog.maximumSelection,
    scenarios: catalog.scenarios.map(({ id, label, description }) => ({ id, label, description })) };
}

/** Validate before any training dispatch. Unknown, duplicated and stale selections fail closed. */
export function validateTrainingSelection<Input>(catalog: TrainingCatalog<Input>, value: unknown): TrainingSelection {
  validateCatalog(catalog); canonicalJson(value);
  const selection = value as TrainingSelection;
  if (!selection || Object.keys(selection).sort().join() !== 'catalog,reason,scenarioIds'
    || canonicalJson(selection.catalog) !== canonicalJson(catalog.revision)
    || typeof selection.reason !== 'string' || !selection.reason.trim() || selection.reason.length > 1000
    || !Array.isArray(selection.scenarioIds) || selection.scenarioIds.length < 1 || selection.scenarioIds.length > catalog.maximumSelection
    || new Set(selection.scenarioIds).size !== selection.scenarioIds.length
    || selection.scenarioIds.some(id => typeof id !== 'string' || !catalog.scenarios.some(scenario => scenario.id === id))) throw new Error('Invalid or stale training selection');
  return JSON.parse(canonicalJson(selection)) as TrainingSelection;
}

/** Fresh copies in supervisor-selected order. This function cannot modify an acceptance contract. */
export function selectedTrainingScenarios<Input>(catalog: TrainingCatalog<Input>, value: unknown): Array<EvaluationScenario<Input>> {
  const selection = validateTrainingSelection(catalog, value);
  return selection.scenarioIds.map(id => {
    const { seed, input } = catalog.scenarios.find(scenario => scenario.id === id)!;
    return JSON.parse(canonicalJson({ id, seed, input })) as EvaluationScenario<Input>;
  });
}

function validateCatalog<Input>(catalog: TrainingCatalog<Input>) {
  canonicalJson(catalog);
  if (!catalog || Object.keys(catalog).sort().join() !== 'format,maximumSelection,revision,scenarios'
    || catalog.format !== 1 || !catalog.revision || Object.keys(catalog.revision).sort().join() !== 'id,version'
    || !text(catalog.revision.id) || !text(catalog.revision.version)
    || !Number.isSafeInteger(catalog.maximumSelection) || catalog.maximumSelection < 0
    || !Array.isArray(catalog.scenarios) || catalog.maximumSelection > catalog.scenarios.length
    || new Set(catalog.scenarios.map(scenario => scenario.id)).size !== catalog.scenarios.length
    || catalog.scenarios.some(scenario => !scenario || Object.keys(scenario).sort().join() !== 'description,id,input,label,seed'
      || !text(scenario.id) || !text(scenario.seed) || !text(scenario.label) || !text(scenario.description))) throw new Error('Invalid host training catalog');
}
function text(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()); }
