import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSupervisorLimits } from '../src/supervisor.ts';
import { BudgetLedger, BudgetExhausted } from '../src/budget.ts';

const limits = { timeoutMs: 1000, maxInputBytes: 1024, maxOutputBytes: 1024, maxCostMicros: 1000000 };
test('supervisor bounds reject invalid JSON, unlimited execution and unsafe accessors', () => {
  validateSupervisorLimits(limits);
  for (const invalid of [{ ...limits, timeoutMs: 0 }, { ...limits, timeoutMs: 300001 }, { ...limits, maxInputBytes: Infinity }, { ...limits, extra: true }]) {
    assert.throws(() => validateSupervisorLimits(invalid));
  }
  let read = false;
  assert.throws(() => validateSupervisorLimits({ ...limits, get timeoutMs() { read = true; return 1000; } }), /accessor|enumerable data/);
  assert.equal(read, false);
});
test('supervisor invocation reservations survive restart independently of decision API calls', async () => {
  const spec = { simulationUnit: 'turns', limits: { supervisorCalls: 1, modelCalls: 2 } }, ledger = new BudgetLedger(spec);
  await ledger.run({ owner: 'improver', operation: 'generate', reserve: { supervisorCalls: 1 } }, async () => ({ value: null, usage: { supervisorCalls: 1 } }));
  const reopened = new BudgetLedger(spec, undefined, ledger.snapshot());
  await assert.rejects(reopened.run({ owner: 'again', operation: 'generate', reserve: { supervisorCalls: 1 } }, async () => assert.fail('must not dispatch')), BudgetExhausted);
  assert.equal(reopened.remaining('modelCalls'), 2);
});
