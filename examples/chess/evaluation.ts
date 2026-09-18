import { canonicalJson } from '@multiverse/gameplay-harness';
import { compareChessHarnesses } from './harness-evaluation.ts';
import { compareChessStrategies } from './strategy-evaluation.ts';
import { isChessHarnessEvaluator } from './evaluation-contract.ts';
import type { ChessEvaluationObserver } from './comparison-view.ts';

/** Resolve the frozen host contract, never a candidate's choice of evaluation method. */
export async function compareChessEvaluation(options: Parameters<typeof compareChessStrategies>[0] & { directory: string; observer?: ChessEvaluationObserver }, signal: AbortSignal) {
  const full = isChessHarnessEvaluator(options.contract.evaluator, options.baseline.policy);
  if (full && canonicalJson(options.baseline.policy) !== canonicalJson(options.candidate.policy)) throw new Error('This chess contract qualifies source changes under the same search policy');
  // Preview failures must not alter the independent outcome or stop gameplay. Authoritative run receipts remain required.
  const show = async (work: () => Promise<void> | undefined) => { try { await work(); } catch {} };
  await show(() => options.observer?.start(options.contract));
  const observed = { ...options, progress: (value: Parameters<ChessEvaluationObserver['progress']>[0]) => show(() => options.observer?.progress(value)),
    persistence: { ...options.persistence, persistRun: async (run: Parameters<ChessEvaluationObserver['run']>[0]) => {
      await options.persistence?.persistRun?.(run); await show(() => options.observer?.run(run));
    } } };
  try {
    const report = await (full ? compareChessHarnesses(observed, signal) : compareChessStrategies(observed, signal));
    await show(() => options.observer?.finish(report)); return report;
  } catch (error) { await show(() => options.observer?.failed()); throw error; }
}
