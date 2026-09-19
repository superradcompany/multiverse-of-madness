import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingMenu, selectedTrainingScenarios, validateTrainingSelection, type TrainingCatalog } from '../src/curriculum.ts';

const catalog: TrainingCatalog<{ position: number }> = { format: 1, revision: { id: 'practice', version: '1' }, maximumSelection: 2,
  scenarios: [1, 2, 3].map(index => ({ id: String(index), label: `Position ${index}`, description: 'Previously observed', seed: `seed-${index}`, input: { position: index } })) };
const selection = { catalog: catalog.revision, scenarioIds: ['3', '1'], reason: 'Revisit the observed failures' };
test('practice selection preserves host inputs and returns independent copies in the requested order', () => {
  assert.deepEqual(trainingMenu(catalog), { catalog: catalog.revision, maximumSelection: 2, scenarios: catalog.scenarios.map(({ id, label, description }) => ({ id, label, description })) });
  const selected = selectedTrainingScenarios(catalog, selection);
  assert.deepEqual(selected.map(value => value.input.position), [3, 1]);
  selected[0]!.input.position = 99;
  assert.equal(catalog.scenarios[2]!.input.position, 3);
  const parsed = validateTrainingSelection(catalog, selection); parsed.scenarioIds.push('2');
  assert.deepEqual(selection.scenarioIds, ['3', '1']);
});
test('stale identities, invented cases, extra grading controls, duplicates and accessors never dispatch', () => {
  for (const invalid of [null, { ...selection, catalog: { id: 'practice', version: 'old' } }, { ...selection, scenarioIds: ['private-acceptance'] },
    { ...selection, scenarioIds: ['1', '1'] }, { ...selection, scenarioIds: ['1', '2', '3'] }, { ...selection, scenarioIds: [] },
    { ...selection, metric: 'easy' }, { ...selection, reason: '' }]) assert.throws(() => selectedTrainingScenarios(catalog, invalid));
  let accessed = false;
  assert.throws(() => validateTrainingSelection(catalog, { ...selection, get reason() { accessed = true; return 'unsafe'; } }));
  assert.equal(accessed, false);
  assert.throws(() => trainingMenu({ ...catalog, scenarios: [catalog.scenarios[0]!, catalog.scenarios[0]!] }));
  assert.throws(() => trainingMenu({ ...catalog, maximumSelection: -1 }));
  assert.deepEqual(trainingMenu({ ...catalog, maximumSelection: 0, scenarios: [] }).scenarios, []);
});
