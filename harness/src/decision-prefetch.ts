/** One owned speculative request. The adapter decides whether its captured facts remain usable. */
export class DecisionPrefetch<Context, Result> {
  private attempt?: {
    context: Context; controller: AbortController;
    task: Promise<{ ok: true; value: Result } | { ok: false; error: unknown }>;
  };
  get pending(): boolean { return this.attempt !== undefined; }
  start(context: Context, decide: (signal: AbortSignal) => Promise<Result>, signal: AbortSignal): boolean {
    if (this.attempt || signal.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Observe rejection immediately, even if the result is never consumed.
    const task = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return decide(controller.signal); })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      .finally(() => signal.removeEventListener('abort', abort));
    this.attempt = { context, controller, task };
    return true;
  }
  cancel(): void { this.attempt?.controller.abort(new Error('Speculative decision no longer needed')); }
  async take(isCurrent: (context: Context, result?: Result) => boolean, signal: AbortSignal): Promise<Result | undefined> {
    const attempt = this.attempt;
    if (!attempt) return undefined;
    const abort = () => attempt.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    if (!isCurrent(attempt.context)) this.cancel();
    try {
      const result = await attempt.task;
      signal.throwIfAborted();
      if (attempt.controller.signal.aborted || !isCurrent(attempt.context, result.ok ? result.value : undefined)) return undefined;
      if (!result.ok) throw result.error;
      return result.value;
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  /** Cancellation joins the provider and its cleanup; it never detaches dispatched work. */
  async discard(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    attempt.controller.abort(new Error('Speculative decision discarded'));
    await attempt.task;
    if (this.attempt === attempt) this.attempt = undefined;
  }
}
