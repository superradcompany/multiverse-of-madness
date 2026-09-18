import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRevisions, type EvaluationContract } from '../src/evaluation.ts';
import { BudgetExhausted } from '../src/budget.ts';

const baseline = { id: 'policy', version: 'baseline' }, candidate = { id: 'policy', version: 'candidate' };
const spec = (): EvaluationContract<{ initial: number }> => ({
  id: 'fixed-cases', evaluator: { id: 'independent-points', version: '1' },
  scenarios: [{ id: 'a', seed: '11', input: { initial: 0 } }, { id: 'b', seed: '22', input: { initial: 5 } }],
  budget: { simulationUnit: 'turns', limits: { simulation: 8, modelCalls: 2 } }, maxRunMs: 1000,
  acceptance: { metric: 'points', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
});
const signal = () => new AbortController().signal;

test('compares fixed scenarios under identical total budgets, counting discarded futures', async () => {
  const calls: string[] = [];
  const result = await compareRevisions(spec(), baseline, candidate, {
    run: async (revision, scenario, ledger) => {
      calls.push(`${scenario.id}:${revision.version}`);
      const winner = revision.version === 'candidate' ? 2 : 1;
      for (const world of ['discarded', 'selected']) await ledger.run({ owner: world, operation: 'trial', reserve: { simulation: 4, modelCalls: 1 } }, async () => ({ value: null, usage: { simulation: 4, modelCalls: 1 } }));
      await assert.rejects(ledger.run({ owner: 'extra', operation: 'trial', reserve: { simulation: 1 } }, async () => assert.fail('no extra computation')), BudgetExhausted);
      return { evidence: { points: scenario.input.initial + winner * 4 }, ending: 'budget' };
    },
    measure: evidence => evidence,
  }, signal());
  assert.equal(result.accepted, true); assert.equal(result.meanGain, 4);
  assert.deepEqual(calls, ['a:baseline', 'a:candidate', 'b:candidate', 'b:baseline']);
  assert.ok(result.runs.every(run => run.budget.entries.reduce((sum, e) => sum + e.usage!.simulation!, 0) === 8));
  assert.ok(result.runs.every(run => run.budget.entries.some(e => e.owner === 'discarded')));
});

test('a high average cannot hide a regression outside the fixed per-case tolerance', async () => {
  const contract = spec();
  const result = await compareRevisions(contract, baseline, candidate, {
    run: async (revision, scenario) => {
      // Mutating copies passed to a revision cannot alter subsequent seeds or acceptance.
      scenario.input.initial = 999; contract.acceptance.maximumCaseRegression = 100;
      return { evidence: { points: revision.version === 'baseline' ? 10 : scenario.id === 'a' ? 100 : 9 }, ending: 'complete' };
    },
    measure: evidence => evidence,
  }, signal());
  assert.equal(result.accepted, false); assert.match(result.reason, /regression/);
  assert.equal(result.contract.acceptance.maximumCaseRegression, 0);
  assert.equal(result.contract.scenarios[0]!.input.initial, 0);
});

test('errors and missing metrics invalidate a comparison instead of dropping bad cases', async () => {
  for (const failure of ['provider', 'metric'] as const) {
    const result = await compareRevisions(spec(), baseline, candidate, {
      run: async (revision, scenario) => {
        if (failure === 'provider' && scenario.id === 'a' && revision.version === 'candidate') throw new Error('provider unavailable');
        return { evidence: { points: 20 }, ending: 'complete' };
      },
      measure: evidence => failure === 'metric' ? { invalid: NaN } : evidence,
    }, signal());
    assert.equal(result.accepted, false);
    assert.equal(result.runs.length, 4);
    assert.ok(result.runs.some(run => run.status === 'error'));
  }
});

test('timed-out work is joined and reports failure even if the adapter catches cancellation', async () => {
  const contract = spec(); contract.maxRunMs = 5; contract.scenarios = contract.scenarios.slice(0, 1);
  let joined = 0;
  const result = await compareRevisions(contract, baseline, candidate, {
    run: async (_revision, _scenario, ledger, current) => {
      await ledger.run({ owner: 'world', operation: 'step', reserve: { simulation: 1 } }, async () => {
        await new Promise<void>(resolve => current.addEventListener('abort', () => resolve(), { once: true }));
        joined++;
        return { value: null, usage: { simulation: 1 } };
      });
      return { evidence: { points: 99 }, ending: 'complete' };
    }, measure: evidence => evidence,
  }, signal());
  assert.equal(joined, 2); assert.equal(result.accepted, false);
  assert.ok(result.runs.every(run => run.status === 'timeout'));
});

test('an adapter cannot hide a detached operation or a caught reservation overrun', async () => {
  for (const failure of ['detached', 'overrun'] as const) {
    const contract = spec(); contract.scenarios = contract.scenarios.slice(0, 1);
    let finished = 0;
    const result = await compareRevisions(contract, baseline, candidate, {
      run: async (_revision, _scenario, ledger, current) => {
        const operation = ledger.run({ owner: 'world', operation: 'step', reserve: { simulation: 1 } }, async () => {
          if (failure === 'detached') await new Promise<void>(resolve => {
            if (current.aborted) resolve(); else current.addEventListener('abort', () => resolve(), { once: true });
          });
          finished++;
          return { value: null, usage: { simulation: failure === 'overrun' ? 2 : 1 } };
        });
        if (failure === 'overrun') await operation.catch(() => {});
        return { evidence: { points: 99 }, ending: 'complete' };
      }, measure: evidence => evidence,
    }, signal());
    assert.equal(finished, 2); assert.equal(result.accepted, false);
    assert.ok(result.runs.every(run => run.status === 'error'));
  }
});

test('cancellation does not produce a passing report from a partial scenario set', async () => {
  const controller = new AbortController();
  const result = await compareRevisions(spec(), baseline, candidate, {
    run: async () => { controller.abort(); return { evidence: { points: 999 }, ending: 'complete' }; },
    measure: evidence => evidence,
  }, controller.signal);
  assert.equal(result.accepted, false); assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]!.status, 'cancelled');
});

test('host early rejection skips unnecessary scenarios only after the complete pair is persisted', async () => {
  const persisted: string[] = [], released: string[] = [];
  const result = await compareRevisions(spec(), baseline, candidate, {
    run: async (revision, scenario) => {
      released.push(`${scenario.id}:${revision.version}`);
      return { evidence: { points: 1 }, ending: 'complete' };
    }, measure: evidence => evidence,
    persistRun: async run => { persisted.push(run.id); },
    rejectAfterPair: (scenario, runs) => {
      assert.equal(scenario.id, 'a'); assert.equal(runs.length, 2);
      assert.equal(persisted.length, 2); assert.equal(released.length, 2);
      assert.ok(runs.every(run => run.budget.entries.every(entry => entry.status !== 'pending')));
      return 'No improvement in the required situation';
    },
  }, signal());
  assert.equal(result.accepted, false); assert.equal(result.runs.length, 2);
  assert.equal(result.reason, 'No improvement in the required situation');
  assert.deepEqual(result.gains, [{ scenarioId: 'a', gain: 0 }]); assert.equal(result.meanGain, undefined);
  assert.deepEqual(released, ['a:baseline', 'a:candidate']);
});

test('a host pair hook cannot qualify missing cases or mutate stored evidence', async () => {
  let checked = 0;
  const result = await compareRevisions(spec(), baseline, candidate, {
    run: async revision => ({ evidence: { points: revision.version === 'candidate' ? 2 : 1 }, ending: 'complete' }),
    measure: evidence => evidence,
    rejectAfterPair: (scenario, runs) => {
      checked++; scenario.id = 'altered'; runs[0]!.metrics!.points = -999;
      return undefined;
    },
  }, signal());
  assert.equal(checked, 2); assert.equal(result.runs.length, 4); assert.equal(result.accepted, true);
  assert.equal(result.runs[0]!.metrics!.points, 1);
});
