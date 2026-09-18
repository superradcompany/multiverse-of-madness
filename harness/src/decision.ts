/** A decision is usable only while the instructions/policy it observed remain current. */
export interface DecisionAttempt<Context, Result> {
  capture(): Context;
  decide(context: Context, signal: AbortSignal): Promise<Result>;
  isCurrent(context: Context): boolean;
}
export interface FreshDecision<Context, Result> {
  context: Context;
  result: Result;
  attempts: number;
}

/** Discard stale judgments before they can alter candidate selection or execution. */
export async function decideCurrent<Context, Result>(
  port: DecisionAttempt<Context, Result>,
  signal: AbortSignal,
  maxAttempts = 8,
): Promise<FreshDecision<Context, Result>> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('Decision attempt budget must be a positive integer');
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    signal.throwIfAborted();
    const context = port.capture();
    signal.throwIfAborted();
    const result = await port.decide(context, signal);
    signal.throwIfAborted();
    if (port.isCurrent(context)) return { context, result, attempts };
  }
  throw new Error('Decision attempt budget exhausted while instructions were changing');
}
