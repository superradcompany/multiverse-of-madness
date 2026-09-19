import { z } from 'zod';

const milliseconds = z.number().finite().nonnegative();
const revision = z.object({ id: z.string().min(1), version: z.string().min(1) });
const timings = z.object({ createMs: milliseconds, uploadMs: milliseconds, executeMs: milliseconds, cleanupMs: milliseconds });
// Project only diagnostic fields. Never include input, source, output or error text.
const journal = z.array(z.object({
  id: z.string().min(1),
  revision,
  phase: z.enum(['creating', 'running', 'released', 'cleanup-failed']),
  receipt: z.object({
    startedAt: milliseconds,
    elapsedMs: milliseconds,
    status: z.enum(['complete', 'failed', 'cancelled', 'timeout']),
    provider: revision,
  }).optional(),
  timings: timings.optional(),
}));
type Run = z.infer<typeof journal>[number];

/** Half-open cohort of invocations whose receipt.startedAt falls in [from, to). */
export interface ExecutorPerformanceWindow { from: number; to: number }

/** Lower observed quantiles, matching the live delivery observer; empty samples stay null. */
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
  return { samples: sorted.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null };
}

function summarize(runs: Run[]) {
  const receipts = runs.flatMap(run => run.receipt ? [run.receipt] : []);
  const measured = runs.flatMap(run => run.receipt && run.timings ? [run.timings] : []);
  return {
    records: runs.length,
    receipts: receipts.length,
    withoutReceipt: runs.length - receipts.length,
    phases: Object.fromEntries(['creating', 'running', 'released', 'cleanup-failed'].map(phase =>
      [phase, runs.filter(run => run.phase === phase).length])),
    elapsed: distribution(receipts.map(receipt => receipt.elapsedMs)),
    byStatus: Object.fromEntries(['complete', 'failed', 'cancelled', 'timeout'].map(status => {
      const cohort = runs.filter(run => run.receipt?.status === status);
      const phases = cohort.flatMap(run => run.timings ? [run.timings] : []);
      return [status, {
        elapsed: distribution(cohort.map(run => run.receipt!.elapsedMs)),
        phaseCoverage: { measured: phases.length, missing: cohort.length - phases.length },
        timings: Object.fromEntries(['createMs', 'uploadMs', 'executeMs', 'cleanupMs'].map(key =>
          [key, distribution(phases.map(value => value[key as keyof typeof value]))])),
      }];
    })),
    phaseCoverage: { measured: measured.length, missing: receipts.length - measured.length },
    providers: [...new Map(receipts.map(receipt => [JSON.stringify(receipt.provider), receipt.provider])).values()],
  };
}

/** Read-only diagnostics for one journal snapshot. Does not import or invoke the VM runtime. */
export function analyzeExecutorPerformance(input: unknown, window?: ExecutorPerformanceWindow) {
  if (window && (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.from < 0 || window.to <= window.from))
    throw new Error('Performance window must have finite timestamps with 0 <= from < to');
  const runs = journal.parse(input);
  const ids = new Set<string>();
  for (const run of runs) {
    if (ids.has(run.id)) throw new Error('Duplicate executor id in journal snapshot');
    ids.add(run.id);
    if (run.timings && !run.receipt) throw new Error('Executor phase timings require a receipt');
  }
  const selected = window ? runs.filter(run => run.receipt && run.receipt.startedAt >= window.from && run.receipt.startedAt < window.to) : runs;
  const revisions = [...new Map(selected.map(run => [JSON.stringify(run.revision), run.revision])).values()];
  return {
    format: 1,
    window: window ?? null,
    selection: {
      totalRecords: runs.length,
      selectedRecords: selected.length,
      outsideWindow: window ? runs.filter(run => run.receipt && (run.receipt.startedAt < window.from || run.receipt.startedAt >= window.to)).length : 0,
      unplacedRecords: window ? runs.filter(run => !run.receipt).length : 0,
    },
    overall: summarize(selected),
    byRevision: revisions.map(revision => ({ revision, ...summarize(selected.filter(run =>
      run.revision.id === revision.id && run.revision.version === revision.version)) })),
    limitations: [
      'One journal snapshot per report; do not sum overlapping journal snapshots or duplicate decision receipts.',
      'Window membership uses receipt.startedAt, not interval overlap; unfinished records have no receipt timestamp and cannot be placed.',
      'Receipt elapsed time excludes the initial and final journal writes; startedAt precedes the initial write. This is not total decision latency.',
      'Missing phase timings are unknown, not zero. Historical receipts may predate phase instrumentation.',
      'Create time includes identity journaling and isolation checks; cleanup includes joined cancellation and VM destruction.',
      'Phase percentiles cannot be added to reconstruct elapsed percentiles. Parallel invocation times are not wall time or VM counts.',
      'Journal phases describe the saved snapshot, not currently running processes. Historical data does not measure current code, browser FPS or gameplay strength.',
    ],
  };
}
