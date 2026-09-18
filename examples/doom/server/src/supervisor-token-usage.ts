import type { BudgetSnapshot } from '@multiverse/gameplay-harness';

export interface SupervisorTokens { inputTokens: number; outputTokens: number }

/** Read only reported counts, including historical Codex records predating token-only receipts. */
export function supervisorTokens(record: unknown, id: string): SupervisorTokens | undefined {
  if (!object(record) || !object(record.receipt) || record.receipt.id !== id) return;
  return tokens(record.receipt.usage) ?? tokens(record.tokenUsage);
}

export function summarizeSupervisorTokens(ledgers: BudgetSnapshot[], receipts: ReadonlyMap<string, SupervisorTokens>) {
  let inputTokens = 0, outputTokens = 0, unknownTokenCalls = 0;
  for (const ledger of ledgers) for (const entry of ledger.entries) {
    const calls = (entry.usage ?? entry.reserved).supervisorCalls ?? 0;
    if (!calls) continue;
    // Receipts are one request each. Never multiply one receipt over several calls.
    const reported = tokens(entry.usage) ?? (calls === 1 ? receipts.get(entry.owner) : undefined);
    if (reported) { inputTokens += reported.inputTokens; outputTokens += reported.outputTokens; }
    else unknownTokenCalls += calls;
  }
  if (![inputTokens, outputTokens, unknownTokenCalls].every(integer)) throw new Error('Supervisor token accounting overflow');
  return { inputTokens, outputTokens, unknownTokenCalls };
}
function tokens(value: unknown): SupervisorTokens | undefined {
  if (!object(value) || !integer(value.inputTokens) || !integer(value.outputTokens)) return;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
