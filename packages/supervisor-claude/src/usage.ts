import type { SupervisorReceipt } from '@multiverse/gameplay-harness';

/** CLI aggregate usage can omit auxiliary requests, particularly after cancellation. */
export function reportedUsage(envelope: Record<string, unknown>): SupervisorReceipt['usage'] {
  const cost = envelope.total_cost_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return;
  const costMicros = Math.ceil(cost * 1_000_000);
  if (!integer(costMicros)) return;
  const aggregate = tokens(envelope.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'], 'output_tokens');
  const models = object(envelope.modelUsage) ? Object.values(envelope.modelUsage) : [];
  const counts = models.map(value => tokens(value, ['inputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'], 'outputTokens'));
  const breakdown = counts.length && counts.every(value => value !== undefined)
    ? counts.reduce((total, value) => ({ inputTokens: total.inputTokens + value!.inputTokens, outputTokens: total.outputTokens + value!.outputTokens }), { inputTokens: 0, outputTokens: 0 }) : undefined;
  if (!aggregate && !breakdown) return;
  // These are overlapping views of the same requests, not additional usage to add together.
  const inputTokens = Math.max(aggregate?.inputTokens ?? 0, breakdown?.inputTokens ?? 0);
  const outputTokens = Math.max(aggregate?.outputTokens ?? 0, breakdown?.outputTokens ?? 0);
  if (!integer(inputTokens) || !integer(outputTokens)) return;
  return { inputTokens, outputTokens, costMicros };
}

function tokens(value: unknown, input: string[], output: string): { inputTokens: number; outputTokens: number } | undefined {
  if (!object(value) || !integer(value[input[0]!]) || !integer(value[output])) return;
  const inputs = input.map((key, index) => value[key] ?? (index > 0 ? 0 : undefined));
  if (!inputs.every(integer)) return;
  const inputTokens = inputs.reduce((sum, count) => sum + count, 0);
  if (!integer(inputTokens)) return;
  return { inputTokens, outputTokens: value[output] as number };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
