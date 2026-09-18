/**
 * One owner for a session's in-flight work. Cancellation requests a stop; join
 * waits for dispatched operations and their cleanup before another owner enters.
 */
export class ExecutionGate {
  private operation?: Promise<void>;
  private controller?: AbortController;
  get pending(): Promise<void> | undefined { return this.operation; }
  get busy(): boolean { return this.operation !== undefined; }

  run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.operation) throw new Error('Session operation is already in progress');
    const controller = new AbortController();
    this.controller = controller;
    // Reserve ownership before invoking user code, including synchronous throws.
    const operation = Promise.resolve().then(() => work(controller.signal)).finally(() => {
      this.operation = undefined;
      this.controller = undefined;
    });
    this.operation = operation;
    return operation;
  }
  cancel(reason?: unknown): void { this.controller?.abort(reason); }
  async join(): Promise<void> { await this.operation; }
  async stop(reason?: unknown): Promise<void> { this.cancel(reason); await this.join(); }
}

/** Abortable presentation pacing; it never changes simulation time. */
export async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid pacing duration');
  if (signal.aborted || milliseconds === 0) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Serialized durable work; one failed task does not prevent later reconciliation. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  get busy(): boolean { return this.count > 0; }
  async join(): Promise<void> { await this.tail; }
  run<T>(work: () => Promise<T>): Promise<T> {
    this.count++;
    const task = this.tail.then(work).finally(() => { this.count--; });
    this.tail = task.then(() => {}, () => {});
    return task;
  }
}
