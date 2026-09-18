import type { SupervisorReceipt } from '@multiverse/gameplay-harness';

/** Cached input is a subset of input, not an additional chargeable token count. */
export function reportedCodexUsage(events: unknown[]): SupervisorReceipt['usage'] {
  const turns = events.filter(object).filter(event => event.type === 'turn.completed');
  if (!turns.length) return;
  let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheKnown = true;
  for (const turn of turns) {
    const usage = turn.usage;
    if (!object(usage) || !integer(usage.input_tokens) || !integer(usage.output_tokens)) return;
    inputTokens += usage.input_tokens; outputTokens += usage.output_tokens;
    if (integer(usage.cached_input_tokens) && usage.cached_input_tokens <= usage.input_tokens) cachedInputTokens += usage.cached_input_tokens;
    else cacheKnown = false;
  }
  if (!integer(inputTokens) || !integer(outputTokens) || !integer(cachedInputTokens)) return;
  return { inputTokens, outputTokens, ...(cacheKnown ? { cachedInputTokens } : {}) };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
