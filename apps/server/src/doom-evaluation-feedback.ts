type Failure = 'insufficient_gameplay' | 'no_simulation_progress' | 'invalid_preparation' | 'other';
interface Summary { complete: number; failed: number; failures: Partial<Record<Failure, number>> }

/** Aggregate host failures for the next proposal without disclosing private cases, states or raw errors. */
export function doomEvaluationFeedback(evidence: unknown): Partial<Record<'baseline' | 'candidate', Summary>> | undefined {
  if (!evidence || typeof evidence !== 'object' || !('runs' in evidence) || !Array.isArray(evidence.runs)) return;
  const result: Partial<Record<'baseline' | 'candidate', Summary>> = {};
  for (const run of evidence.runs) {
    if (!run || typeof run !== 'object' || (run.role !== 'baseline' && run.role !== 'candidate')) continue;
    const summary = result[run.role as 'baseline' | 'candidate'] ??= { complete: 0, failed: 0, failures: {} };
    if (run.status === 'complete') { summary.complete++; continue; }
    summary.failed++;
    const message = typeof run.error === 'string' ? run.error : '';
    const failure: Failure = /^Insufficient selected gameplay: \d+\/\d+ required ticks;/.test(message) ? 'insufficient_gameplay'
      : /^Trial .+ exhausted its idle-transition budget$/.test(message) ? 'no_simulation_progress'
      : /^Prepared (context|features|plans|step|target|actor|attacks|history)/.test(message) ? 'invalid_preparation' : 'other';
    summary.failures[failure] = (summary.failures[failure] ?? 0) + 1;
  }
  return Object.keys(result).length ? result : undefined;
}
