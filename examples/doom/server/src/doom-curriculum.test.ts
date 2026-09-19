import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { trainingMenu, type EvaluationContract } from '@multiverse/gameplay-harness';
import { doomTrainingCatalog, doomTrainingContract, validateDoomTrainingCatalog } from './doom-curriculum.ts';
import { doomIncidentCheckpoint } from './doom-evaluation-vms.ts';
import type { DoomVmScenario } from './doom-vm-evaluations.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

test('observed practice freezes history, hides runtime identities and excludes current, private and stale-context states', async () => {
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('observed-source'));
  const observed = [];
  for (let index = 0; index < 3; index++) {
    const evidence = session.checkpoint(), state = evidence.worlds[0]!.view.state, proposalId = randomUUID();
    observed.push({ proposalId, evidence, snapshot: doomIncidentCheckpoint(`mom-checkpoint-${proposalId}:recovery`, 'physical-' + proposalId, state) });
    await session.takeover('observed-source'); await session.input('observed-source', ['forward']); session.release('observed-source');
  }
  const current = observed[2]!.evidence;
  const acceptance: EvaluationContract<DoomVmScenario> = { id: 'acceptance', evaluator: { id: 'host', version: '1' },
    scenarios: [{ id: 'private-opening', seed: 'private-seed', input: { setup: [] } }, { id: 'current', seed: 'host', input: { setup: [], incident: observed[2]!.snapshot } }],
    budget: { simulationUnit: 'doom-ticks', limits: {} }, maxRunMs: 1000,
    acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } };
  const stale = structuredClone(observed[1]!); stale.evidence.view.objective = 'Different objective';
  const catalog = doomTrainingCatalog(acceptance, [observed[2]!, stale, observed[0]!, observed[0]!], current);
  validateDoomTrainingCatalog(catalog);
  const cases = catalog.scenarios.filter(scenario => scenario.input.incident);
  assert.equal(cases.length, 1); assert.deepEqual(cases[0]!.input.continuation!.history, observed[0]!.evidence.worlds[0]!.history);
  assert.equal(catalog.scenarios.some(scenario => scenario.id === 'opening'), false);
  const encoded = JSON.stringify(trainingMenu(catalog));
  for (const secret of ['physical-', 'mom-checkpoint-', 'private-seed', 'continuation', 'observed-source']) assert.equal(encoded.includes(secret), false);
  assert.match(encoded, /Observed E1M1/);
  const selection = { catalog: catalog.revision, scenarioIds: [cases[0]!.id], reason: 'Retry an earlier observed state' };
  const before = structuredClone(acceptance), contract = doomTrainingContract(acceptance, selection, catalog);
  assert.deepEqual(acceptance, before); assert.deepEqual(contract.scenarios[0]!.input.incident, observed[0]!.snapshot);
  assert.throws(() => doomTrainingContract({ ...acceptance, scenarios: [...acceptance.scenarios, { id: 'now-private', seed: 'host', input: cases[0]!.input }] }, selection, catalog), /acceptance starting state/);
  observed[0]!.evidence.worlds[0]!.history.length = 0;
  assert.ok(contract.scenarios[0]!.input.continuation!.history.length);
  const altered = structuredClone(catalog); altered.scenarios[0]!.input.incident!.identity = 'changed';
  assert.throws(() => validateDoomTrainingCatalog(altered), /content changed/);
  await session.close();
});
