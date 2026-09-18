import test from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetSnapshot } from '@multiverse/gameplay-harness';
import { summarizeSupervisorTokens, supervisorTokens } from './supervisor-token-usage.ts';

test('historical Codex tokens are recovered without duplicating ledger counts or rewriting receipts', () => {
  const old = { receipt: { id: 'old' }, tokenUsage: { inputTokens: 25000, outputTokens: 446 } };
  const reported = { receipt: { id: 'new', usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 8 } }, tokenUsage: { inputTokens: 99, outputTokens: 99 } };
  const frozen = JSON.stringify([old, reported]);
  const ledger: BudgetSnapshot = { version: 1, spec: { simulationUnit: 'ticks', limits: {} }, entries: [
    { id: 1, owner: 'old', operation: 'propose', reserved: { supervisorCalls: 1 }, usage: { supervisorCalls: 1 }, status: 'complete' },
    { id: 2, owner: 'new', operation: 'propose', reserved: { supervisorCalls: 1 }, usage: { supervisorCalls: 1, inputTokens: 10, outputTokens: 4 }, status: 'complete' },
    { id: 3, owner: 'pending', operation: 'propose', reserved: { supervisorCalls: 1 }, status: 'pending' },
  ] };
  const receipts = new Map([['old', supervisorTokens(old, 'old')!], ['new', supervisorTokens(reported, 'new')!]]);
  assert.deepEqual(summarizeSupervisorTokens([ledger], receipts), { inputTokens: 25010, outputTokens: 450, unknownTokenCalls: 1 });
  assert.equal(JSON.stringify([old, reported]), frozen);
});
test('unknown or mismatched token evidence stays unknown, while reported zero is valid', () => {
  for (const record of [null, {}, { receipt: { id: 'another', usage: { inputTokens: 1, outputTokens: 1 } } },
    { receipt: { id: 'job', usage: { inputTokens: -1, outputTokens: 1 } } }, { receipt: { id: 'job' }, tokenUsage: { inputTokens: 1 } }]) {
    assert.equal(supervisorTokens(record, 'job'), undefined);
  }
  assert.deepEqual(supervisorTokens({ receipt: { id: 'job', usage: { inputTokens: 0, outputTokens: 0 } } }, 'job'), { inputTokens: 0, outputTokens: 0 });
});
