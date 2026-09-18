import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedCodexUsage } from './usage.ts';

const turn = (input_tokens: unknown, output_tokens: unknown, cached_input_tokens?: unknown) => ({ type: 'turn.completed', usage: { input_tokens, output_tokens, cached_input_tokens } });
test('Codex sums completed turns and reports cache as part of input without inventing a price', () => {
  assert.deepEqual(reportedCodexUsage([{ type: 'item.completed' }, turn(100, 10, 70), turn(50, 5, 20)]),
    { inputTokens: 150, outputTokens: 15, cachedInputTokens: 90 });
  assert.deepEqual(reportedCodexUsage([turn(10, 3)]), { inputTokens: 10, outputTokens: 3 });
  assert.deepEqual(reportedCodexUsage([turn(10, 3, 99)]), { inputTokens: 10, outputTokens: 3 });
  assert.deepEqual(reportedCodexUsage([turn(0, 0, 0)]), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
});
test('missing, partial, malformed and overflowing Codex usage stays unknown', () => {
  for (const events of [[], [{ type: 'turn.failed' }], [turn(10, 2), turn(undefined, 5)], [turn(-1, 2)],
    [turn(1.5, 2)], [turn('10', 2)], [turn(Number.MAX_SAFE_INTEGER, 2), turn(1, 2)]]) assert.equal(reportedCodexUsage(events), undefined);
});
