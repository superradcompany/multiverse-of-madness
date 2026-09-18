import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedUsage } from './usage.ts';

test('interrupted CLI calls retain per-model usage even when the aggregate is empty', () => {
  assert.deepEqual(reportedUsage({ total_cost_usd: 0.002146, usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: { helper: { inputTokens: 2076, outputTokens: 14, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }),
  { inputTokens: 2076, outputTokens: 14, costMicros: 2146 });
});

test('overlapping totals are not double counted and absent or invalid usage is unknown', () => {
  const usage = { input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10 };
  const modelUsage = { a: { inputTokens: 10, cacheReadInputTokens: 30, outputTokens: 8 }, b: { inputTokens: 10, outputTokens: 2 } };
  assert.deepEqual(reportedUsage({ total_cost_usd: 0.001, usage, modelUsage }), { inputTokens: 50, outputTokens: 10, costMicros: 1000 });
  assert.equal(reportedUsage({ total_cost_usd: 0 }), undefined);
  assert.equal(reportedUsage({ total_cost_usd: Infinity, usage }), undefined);
  assert.equal(reportedUsage({ total_cost_usd: 1, modelUsage: { a: { inputTokens: -1, outputTokens: 1 } } }), undefined);
  assert.equal(reportedUsage({ total_cost_usd: 1, usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, output_tokens: 1 } }), undefined);
});
