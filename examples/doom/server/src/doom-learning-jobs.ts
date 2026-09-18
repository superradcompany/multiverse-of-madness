import type { SupervisorCli } from '../../contracts/src/learning.ts';
import { z } from 'zod';
import { canonicalJson, type CheckpointStore, type RevisionProposal, type VersionRef } from '@multiverse/gameplay-harness';
import { decodeDoomProposal, doomProposalKindSchema, generateDoomProposal, type DoomProposalOptions, type DoomProposalRecord } from './doom-supervisor-proposal.ts';
import type { DoomSupervisor } from './doom-supervisor.ts';

const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('propose'), id: z.string().uuid(), proposalKind: doomProposalKindSchema.optional(), provider: z.enum(['codex', 'claude']).optional() }),
  z.strictObject({ kind: z.literal('evaluate'), id: z.string().uuid(), proposalId: z.string().uuid() }),
]);
export type DoomLearningCommand = z.infer<typeof commandSchema>;
const jobSchema = z.strictObject({
  command: commandSchema, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  status: z.enum(['queued', 'running', 'cancelling', 'complete', 'failed', 'cancelled', 'interrupted']),
  outcome: z.string().max(80).optional(), error: z.string().max(1000).optional(),
});
export type DoomLearningJob = z.infer<typeof jobSchema>;
export interface SavedDoomLearningJobs { version: 1; binding: VersionRef; jobs: DoomLearningJob[] }
const savedSchema = z.strictObject({ version: z.literal(1), binding: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }), jobs: z.array(jobSchema) });
export function decodeDoomLearningJobs(value: unknown): SavedDoomLearningJobs {
  const parsed = savedSchema.parse(value);
  if (new Set(parsed.jobs.map(job => job.command.id)).size !== parsed.jobs.length) throw new Error('Duplicate learning job identity');
  if (parsed.jobs.filter(job => pending(job.status)).length > 1) throw new Error('Multiple unfinished learning jobs');
  return parsed;
}
export interface DoomLearningJobOptions {
  supervisor: DoomSupervisor;
  /** Exclusively owned together with the supervisor journal. This class is not a cross-process lock. */
  store: CheckpointStore<SavedDoomLearningJobs>;
  /** Stable, exclusively owned store per UUID. A missing record on restart must never trigger generation. */
  proposalStore(id: string): CheckpointStore<DoomProposalRecord>;
  /** Lazy provider configuration. Constructing it must not dispatch work or reset the durable spending ledger. */
  proposalOptions(id: string, store: CheckpointStore<DoomProposalRecord>, signal: AbortSignal, provider?: SupervisorCli): Promise<DoomProposalOptions>;
  /** Reconcile and release interrupted evaluator/executor resources before accepting new work. */
  recover(): Promise<void>;
  /** Runs after provider/evaluator work has joined, before another job may start. */
  settled?(): Promise<void>;
}
type ActiveJob = { job: DoomLearningJob; control: AbortController; done: Promise<void> };

/** One bounded background experiment at a time. HTTP requests acknowledge admission, not completion. */
export class DoomLearningJobs {
  private active?: ActiveJob;
  private closed = false;
  private closing?: Promise<void>;
  private publicationFailure?: { error: unknown };
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly options: DoomLearningJobOptions, private readonly saved: SavedDoomLearningJobs) {}

  static async open(options: DoomLearningJobOptions): Promise<DoomLearningJobs> {
    const input = await options.store.load();
    const saved = input === undefined ? { version: 1 as const, binding: options.supervisor.binding.identity, jobs: [] }
      : decodeDoomLearningJobs(input);
    if (!same(saved.binding, options.supervisor.binding.identity)) throw new Error('Learning jobs belong to another supervisor');
    const owner = new DoomLearningJobs(options, structuredClone(saved));
    // The supervisor must already have reopened its journal, marking old evaluations interrupted.
    if (options.supervisor.snapshot().journal.proposals.some(proposal => proposal.status === 'evaluating')) throw new Error('Cannot recover jobs with a running evaluation');
    await options.recover();
    for (const job of owner.saved.jobs) if (pending(job.status) || job.status === 'failed') await owner.reconcile(job);
    await owner.publish();
    return owner;
  }

  /** Safe for polling; never includes private evaluator states, raw model packets or source files. */
  snapshot(): SavedDoomLearningJobs { return structuredClone(this.saved); }
  get busy(): boolean { return this.active !== undefined; }

  async start(input: DoomLearningCommand): Promise<DoomLearningJob> {
    this.usable();
    const command = commandSchema.parse(input);
    const previous = this.saved.jobs.find(job => job.command.id === command.id);
    if (previous) {
      if (!same(previous.command, command)) throw new Error('Learning job id was already used for a different request');
      // In particular, repeated POSTs cannot repeat a failed, cancelled or interrupted paid call.
      await this.writes; return structuredClone(previous);
    }
    if (this.active) throw new Error('Another learning job is still running or cleaning up');
    if (command.kind === 'evaluate') {
      const proposal = this.options.supervisor.snapshot().journal.proposals.find(item => item.id === command.proposalId);
      if (!proposal || proposal.status !== 'proposed') throw new Error('Only an unevaluated proposal can be evaluated');
    }
    const now = Date.now();
    const job: DoomLearningJob = { command, createdAt: now, updatedAt: now, status: 'queued' };
    const active: ActiveJob = { job, control: new AbortController(), done: Promise.resolve() };
    this.active = active; this.saved.jobs.push(job);
    // Fence synchronously, before the first disk await. Cancellation can arrive during admission.
    const admitted = this.publish();
    active.done = this.execute(active, admitted).finally(() => { if (this.active === active) this.active = undefined; });
    // Completion errors remain observable via join/close and poison further admission; no detached rejection.
    void active.done.catch(() => {});
    await admitted;
    return structuredClone(job);
  }

  /** Returns promptly, but the job remains busy until the provider/evaluator has joined all cleanup. */
  async cancel(id: string): Promise<DoomLearningJob> {
    this.usable(); z.string().uuid().parse(id);
    const job = this.saved.jobs.find(item => item.command.id === id);
    if (!job) throw new Error('Unknown learning job');
    if (this.active?.job === job && pending(job.status)) {
      this.active.control.abort(new Error('Learning job cancelled by user'));
      job.status = 'cancelling'; job.updatedAt = Date.now(); await this.publish();
    }
    return structuredClone(job);
  }

  async join(): Promise<void> { await this.active?.done; await this.writes; }

  /** Call before closing the supervisor or releasing process ownership. Browser disconnects do not call this. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.active?.control.abort(new Error('Learning job owner closing'));
    this.closing = this.shutdown(); return this.closing;
  }
  private async shutdown(): Promise<void> {
    try { await this.join(); } finally { await this.options.store.flush?.(); }
  }

  private async execute(active: ActiveJob, admitted: Promise<void>): Promise<void> {
    const { job, control } = active;
    try {
      await admitted; control.signal.throwIfAborted();
      job.status = 'running'; job.updatedAt = Date.now(); await this.publish();
      control.signal.throwIfAborted();
      if (job.command.kind === 'propose') {
        const store = this.options.proposalStore(job.command.id);
        const options = await this.options.proposalOptions(job.command.id, store, control.signal, job.command.provider);
        if (options.id !== job.command.id || options.supervisor !== this.options.supervisor || options.store !== store) throw new Error('Proposal configuration does not match its job owner');
        control.signal.throwIfAborted();
        const result = await generateDoomProposal({ ...options, kind: job.command.proposalKind }, control.signal);
        // The committed journal wins a cancellation race at the final publication boundary.
        if (this.options.supervisor.snapshot().journal.proposals.some(item => item.id === job.command.id)) {
          await this.reconcileGeneration(job, result);
        } else {
          job.outcome = result.status;
          job.status = result.status === 'cancelled' ? 'cancelled' : result.status === 'interrupted' ? 'interrupted' : 'failed';
          job.error = result.error ?? 'Generation did not publish a proposal';
        }
      } else {
        const proposal = await this.options.supervisor.evaluate(job.command.proposalId, control.signal);
        this.evaluationResult(job, proposal);
      }
    } catch (error) {
      job.status = control.signal.aborted ? 'cancelled' : 'failed';
      job.error = message(error);
      // The controller may have published before an acknowledgment failed. Do not rerun or guess;
      // authoritative recovery on the next host will reconcile the records.
    } finally {
      job.updatedAt = Date.now(); await this.publish();
      try { await this.options.settled?.(); }
      catch (error) { this.publicationFailure = { error }; throw error; }
    }
  }

  private async reconcile(job: DoomLearningJob): Promise<void> {
    if (job.command.kind === 'propose') {
      const store = this.options.proposalStore(job.command.id), value = await store.load();
      if (value) {
        const record = decodeDoomProposal(value);
        await this.reconcileGeneration(job, record);
        if (job.status !== 'complete' && ['requested', 'responded', 'ready'].includes(record.status)) {
          record.status = 'interrupted'; record.error = 'Host restarted; generation was not retried'; await store.save(record);
        }
      } else {
        if (this.options.supervisor.snapshot().journal.proposals.some(item => item.id === job.command.id)) throw new Error('Published proposal is missing its generation record');
        if (pending(job.status)) { job.status = 'interrupted'; job.error = 'Host restarted before generation was recorded; no call was dispatched on recovery'; }
      }
    } else {
      const { proposalId } = job.command;
      const proposal = this.options.supervisor.snapshot().journal.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new Error('Evaluation job refers to a missing proposal');
      if (proposal.status === 'proposed') { job.status = 'interrupted'; job.error = 'Host restarted before evaluation was recorded; evaluation was not retried'; }
      else this.evaluationResult(job, proposal);
    }
    job.updatedAt = Date.now();
  }

  private async reconcileGeneration(job: DoomLearningJob, record: DoomProposalRecord): Promise<void> {
    if (record.id !== job.command.id || !same(record.binding, this.saved.binding)) throw new Error('Generation record belongs to another job or supervisor');
    if (job.command.kind !== 'propose' || record.request.evidence.requestedKind !== job.command.proposalKind) throw new Error('Generation kind does not match its job request');
    const proposal = this.options.supervisor.snapshot().journal.proposals.find(item => item.id === record.id);
    if (proposal) {
      if (!record.candidate || !same(proposal.candidate, record.candidate.revision) || !same(proposal.basedOn, record.request.origin.activation)
        || !same(proposal.context, record.request.origin.context) || proposal.reason !== record.reason) throw new Error('Generation record does not match the published proposal');
      job.status = 'complete'; job.outcome = 'submitted'; delete job.error;
      if (record.status !== 'submitted') { record.status = 'submitted'; delete record.error; await this.options.proposalStore(record.id).save(record); }
    } else {
      if (record.status === 'submitted') throw new Error('Submitted generation record is missing its proposal');
      job.status = record.status === 'failed' ? 'failed' : record.status === 'cancelled' ? 'cancelled' : 'interrupted';
      job.outcome = record.status; job.error = record.error ?? 'Host restarted; generation was not retried';
    }
  }

  private evaluationResult(job: DoomLearningJob, proposal: RevisionProposal): void {
    job.outcome = proposal.status;
    job.status = ['qualified', 'rejected', 'activated', 'stale', 'expired'].includes(proposal.status) ? 'complete'
      : proposal.status === 'cancelled' ? 'cancelled' : proposal.status === 'interrupted' ? 'interrupted' : 'failed';
    if (proposal.error) job.error = proposal.error.slice(0, 1000); else delete job.error;
  }
  private usable(): void {
    if (this.closed) throw new Error('Learning job owner is closed');
    if (this.publicationFailure) throw new Error('Learning job publication failed; reopen the owner before continuing', { cause: this.publicationFailure.error });
  }
  private publish(): Promise<void> {
    const saved = structuredClone(this.saved);
    this.writes = this.writes.then(() => this.options.store.save(saved)).catch(error => { this.publicationFailure = { error }; throw error; });
    return this.writes;
  }
}
function pending(status: DoomLearningJob['status']): boolean { return ['queued', 'running', 'cancelling'].includes(status); }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : 'Learning job failed'; }
