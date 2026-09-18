import type { Duration, GameClock } from './contracts.ts';

/** A resumable trial. The adapter owns state; the runner owns its execution fence. */
export interface Trial {
  readonly id: string;
  readonly baseline: GameClock;
  readonly duration: Duration;
  clock(): GameClock;
  terminal(): boolean;
  /** Execute at most the remaining simulation budget, checking cancellation before inputs. */
  advance(remaining: Duration, signal: AbortSignal): Promise<void>;
  /** Publish remaining budget, including after interrupted/dispatched work settles. */
  progress?(remaining: Duration): void;
  /** Release transient flags/leases, including on cancellation and failure. */
  settled?(): void | Promise<void>;
}
export interface TrialResult {
  id: string;
  elapsed: Duration;
  remaining: Duration;
  status: 'completed' | 'terminal' | 'cancelled';
}
export interface TrialRunOptions {
  /** Bounds zero-time transitions such as replanning when no input is feasible. */
  maxIdleTransitions?: number;
}

/**
 * Run equal-budget futures independently. A failure cancels siblings, then joins
 * every task before throwing its original cause. Aborting never detaches work.
 * Runtime adapters must finish or cancel dispatched operations before returning.
 */
export async function runTrials(trials: readonly Trial[], signal: AbortSignal, options: TrialRunOptions = {}): Promise<TrialResult[]> {
  const maxIdle = options.maxIdleTransitions ?? 64;
  if (!Number.isSafeInteger(maxIdle) || maxIdle < 1) throw new Error('Invalid idle-transition budget');
  // Pin the batch contract; edits to session controls apply to the next batch.
  const scheduled: Trial[] = trials.map(trial => ({
    id: trial.id,
    baseline: { ...trial.baseline },
    duration: { ...trial.duration },
    clock: () => trial.clock(),
    terminal: () => trial.terminal(),
    advance: (remaining, current) => trial.advance(remaining, current),
    progress: remaining => trial.progress?.(remaining),
    settled: () => trial.settled?.(),
  }));
  const ids = new Set<string>();
  for (const trial of scheduled) {
    if (!trial.id || ids.has(trial.id)) throw new Error('Trial IDs must be nonempty and unique');
    ids.add(trial.id);
    validateClock(trial.baseline);
    if (trial.duration.unit !== trial.baseline.unit || !Number.isFinite(trial.duration.amount) || trial.duration.amount <= 0) throw new Error(`Invalid duration for trial ${trial.id}`);
    if (scheduled[0]!.duration.unit !== trial.duration.unit || scheduled[0]!.duration.amount !== trial.duration.amount) throw new Error('Compared trials require equal simulation budgets');
    remainingFor(trial); // Validate the entire batch before dispatching any work.
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let failure: { cause: unknown } | undefined;
  const fail = (cause: unknown) => { failure ??= { cause }; controller.abort(cause); };
  try {
    const outcomes = await Promise.allSettled(scheduled.map(async trial => {
      try {
        let idle = 0;
        for (;;) {
          const remaining = remainingFor(trial);
          trial.progress?.(remaining);
          if (controller.signal.aborted || remaining.amount === 0 || trial.terminal()) break;
          const before = { ...trial.clock() };
          await trial.advance(remaining, controller.signal);
          const after = trial.clock();
          validateClock(after);
          if (after.unit !== before.unit || after.elapsed < before.elapsed || after.sequence < before.sequence) throw new Error(`Trial ${trial.id} moved its clock backwards`);
          remainingFor(trial);
          idle = after.elapsed === before.elapsed ? idle + 1 : 0;
          if (idle >= maxIdle && !controller.signal.aborted && !trial.terminal()) throw new Error(`Trial ${trial.id} exhausted its idle-transition budget`);
        }
        const remaining = remainingFor(trial);
        return {
          id: trial.id,
          elapsed: { amount: trial.duration.amount - remaining.amount, unit: trial.duration.unit },
          remaining,
          status: controller.signal.aborted ? 'cancelled' : trial.terminal() ? 'terminal' : 'completed',
        } satisfies TrialResult;
      } catch (error) { fail(error); throw error; }
      finally {
        try {
          try { trial.progress?.(remainingFor(trial)); }
          finally { await trial.settled?.(); }
        } catch (error) { fail(error); throw error; }
      }
    }));
    if (failure) throw failure.cause;
    return outcomes.map(outcome => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
  } finally { signal.removeEventListener('abort', abort); }
}

function validateClock(clock: GameClock): void {
  if (!Number.isSafeInteger(clock.sequence) || clock.sequence < 0 || !Number.isFinite(clock.elapsed) || clock.elapsed < 0
    || (clock.unit !== 'seconds' && clock.unit !== 'turns')) throw new Error('Invalid simulation clock');
}
function remainingFor(trial: Trial): Duration {
  const current = trial.clock();
  validateClock(current);
  if (current.unit !== trial.baseline.unit || current.sequence < trial.baseline.sequence || current.elapsed < trial.baseline.elapsed) throw new Error(`Trial ${trial.id} does not follow its baseline clock`);
  const remaining = trial.duration.amount - (current.elapsed - trial.baseline.elapsed);
  // Conversion from an adapter's ticks to seconds can introduce rounding noise.
  const tolerance = Number.EPSILON * 16 * Math.max(1, current.elapsed, trial.baseline.elapsed, trial.duration.amount);
  if (remaining < -tolerance) throw new Error(`Trial ${trial.id} exceeded its simulation budget`);
  return { amount: Math.abs(remaining) <= tolerance ? 0 : remaining, unit: trial.duration.unit };
}
