import { canonicalJson, type CheckpointStore, type VersionRef } from '@multiverse/gameplay-harness';
import { z } from 'zod';

const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('propose'), id: z.string().uuid() }),
  z.strictObject({ kind: z.literal('evaluate'), id: z.string().uuid(), proposalId: z.string().uuid() }),
]);
export type ChessLearningCommand = z.infer<typeof commandSchema>;
const jobSchema = z.strictObject({ command: commandSchema, status: z.enum(['queued', 'running', 'cancelling', 'complete', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), error: z.string().optional() });
export type ChessLearningJob = z.infer<typeof jobSchema>;
const journalSchema = z.strictObject({ version: z.literal(1), binding: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }), jobs: z.array(jobSchema) });
export type ChessLearningJobJournal = z.infer<typeof journalSchema>;
export function decodeChessLearningJobs(input: unknown): ChessLearningJobJournal {
  const saved = journalSchema.parse(input);
  if (new Set(saved.jobs.map(job => job.command.id)).size !== saved.jobs.length || saved.jobs.filter(job => pending(job)).length > 1) throw new Error('Invalid chess learning job identities or ownership');
  return saved;
}
interface JobPorts {
  binding: VersionRef; store: CheckpointStore<ChessLearningJobJournal>;
  /** Must join dispatched CLI/executor work before settling, including cancellation. */
  execute(command: ChessLearningCommand, signal: AbortSignal): Promise<void>;
  /** Reconcile exact owned executor resources before admission after restart. Never regenerate. */
  recover(): Promise<void>;
  /** Join cleanup even after execution failure. A failure fences admission until reopen. */
  settled(): Promise<void>;
}
type Active = { job: ChessLearningJob; control: AbortController; done: Promise<void> };

/** Single-writer background owner. The application must hold its data-directory lease. */
export class ChessLearningJobs {
  private active?: Active;
  private failure?: { error: unknown };
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(private readonly ports: JobPorts, private readonly journal: ChessLearningJobJournal) {}
  static async open(ports: JobPorts) {
    const saved = await ports.store.load();
    const journal = saved ? decodeChessLearningJobs(saved) : { version: 1 as const, binding: structuredClone(ports.binding), jobs: [] };
    if (canonicalJson(journal.binding) !== canonicalJson(ports.binding)) throw new Error('Chess jobs belong to another learning journal');
    const owner = new ChessLearningJobs(ports, structuredClone(journal));
    await ports.recover();
    for (const job of owner.journal.jobs) if (pending(job)) { job.status = 'interrupted'; job.updatedAt = Date.now(); job.error = 'Server stopped before the job completed; this request will not be dispatched again.'; }
    await owner.publish(); return owner;
  }
  get busy() { return this.active !== undefined; }
  snapshot(): ChessLearningJobJournal { return structuredClone(this.journal); }
  async start(input: ChessLearningCommand): Promise<ChessLearningJob> {
    this.usable(); const command = commandSchema.parse(input), previous = this.journal.jobs.find(job => job.command.id === command.id);
    if (previous) {
      if (canonicalJson(previous.command) !== canonicalJson(command)) throw new Error('Chess learning job identity reused');
      await this.writes; return structuredClone(previous);
    }
    if (this.active) throw new Error('Another chess learning job is running or cleaning up');
    const now = Date.now(), job: ChessLearningJob = { command, createdAt: now, updatedAt: now, status: 'queued' };
    const active: Active = { job, control: new AbortController(), done: Promise.resolve() };
    this.active = active; this.journal.jobs.push(job);
    const admitted = this.publish();
    active.done = this.execute(active, admitted).finally(() => { if (this.active === active) this.active = undefined; });
    void active.done.catch(() => {});
    await admitted; return structuredClone(job);
  }
  async cancel(id: string) {
    const active = this.active;
    if (!active || active.job.command.id !== id) return;
    active.control.abort(new Error('Chess learning job cancelled'));
    await active.done;
  }
  async join() { await this.active?.done; await this.writes; if (this.failure) throw this.failure.error; }
  async close() {
    this.closed = true; this.active?.control.abort(new Error('Chess learning shutdown'));
    await this.join(); await this.ports.store.flush?.();
  }
  private async execute(active: Active, admitted: Promise<void>) {
    const { job, control } = active;
    try {
      await admitted; control.signal.throwIfAborted(); job.status = 'running'; job.updatedAt = Date.now(); await this.publish();
      await this.ports.execute(structuredClone(job.command), control.signal);
      job.status = control.signal.aborted ? 'cancelled' : 'complete';
    } catch (error) {
      job.status = control.signal.aborted ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message.slice(0, 1000) : 'Chess learning job failed';
    } finally {
      try { await this.ports.settled(); }
      catch (error) { this.failure = { error }; job.status = 'failed'; job.error = 'Chess learning resource cleanup failed; reopen to recover.'; }
      job.updatedAt = Date.now();
      if (!this.failure) await this.publish();
    }
    if (this.failure) throw this.failure.error;
  }
  private usable() {
    if (this.failure) throw this.failure.error;
    if (this.closed) throw new Error('Chess learning jobs are closed');
  }
  private publish() {
    const snapshot = this.snapshot();
    this.writes = this.writes.then(async () => {
      if (this.failure) throw this.failure.error;
      try { await this.ports.store.save(snapshot); }
      catch (error) { this.failure = { error }; throw error; }
    });
    void this.writes.catch(() => {}); return this.writes;
  }
}
function pending(job: ChessLearningJob) { return ['queued', 'running', 'cancelling'].includes(job.status); }
