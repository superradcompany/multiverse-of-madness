import type { CheckpointStore } from './contracts.ts';
import type { ProposalStatus } from './revisions.ts';

export interface LearningObservation<Mark> { mark: Mark; reason: string }
export interface AutonomousCycle<Mark> extends LearningObservation<Mark> { proposalId: string; evaluationId: string }
export interface AutonomousLearningState<Mark> {
  version: 1;
  enabled: boolean;
  lastObservation?: Mark;
  cycle?: AutonomousCycle<Mark>;
  lastOutcome?: { proposalId: string; status: string; reason?: string };
  error?: string;
}
export interface AutonomousJob { status: 'queued' | 'running' | 'cancelling' | 'complete' | 'failed' | 'cancelled' | 'interrupted'; error?: string }
export interface AutonomousLearningPorts<Mark> {
  store: CheckpointStore<AutonomousLearningState<Mark>>;
  /** Return only a new meaningful window of observed gameplay. No paid model call here. */
  observe(previous?: Mark): LearningObservation<Mark> | undefined;
  id(): string;
  busy(): boolean;
  job(id: string): AutonomousJob | undefined;
  proposal(id: string): { status: ProposalStatus; error?: string } | undefined;
  /** Durable idempotent admission. Retrying the same ID must never dispatch paid work twice. */
  propose(id: string): Promise<void>;
  evaluate(id: string, proposalId: string): Promise<void>;
  /** Queue or publish at a natural gameplay boundary. Never pause/resume human gameplay implicitly. */
  activate(proposalId: string): Promise<'pending' | 'activated'>;
  /** Capture a fresh evidence baseline after activation, including recovered activation.
   * Pure host observation only; no paid calls or gameplay mutation. Persisted with the outcome
   * so failures accumulated while testing the old revision cannot immediately trigger review.
   * Omit to retain the original observation mark.
   */
  activationObservation?(previous: Mark): Mark;
  /** Cancel and join only this cycle's owned work; leave manually admitted jobs untouched. */
  cancel(cycle: AutonomousCycle<Mark>): Promise<void>;
}

/** Background improvement state machine. A host timer/event wakes it; the browser is not its owner. */
export class AutonomousLearning<Mark> {
  private turn?: Promise<void>;
  private stopping = false;
  private closed = false;
  private failure?: unknown;
  private constructor(private readonly ports: AutonomousLearningPorts<Mark>, private readonly state: AutonomousLearningState<Mark>) {}

  static async open<Mark>(ports: AutonomousLearningPorts<Mark>, enabled = false): Promise<AutonomousLearning<Mark>> {
    const saved = await ports.store.load();
    if (saved && (saved.version !== 1 || typeof saved.enabled !== 'boolean')) throw new Error('Unsupported autonomous learning state');
    return new AutonomousLearning(ports, structuredClone(saved ?? { version: 1, enabled }));
  }
  snapshot(): AutonomousLearningState<Mark> { return structuredClone(this.state); }

  /** Coalesce wakes. Generation/evaluation execute in their own durable job owners. */
  tick(): Promise<void> {
    if (this.closed || this.stopping || !this.state.enabled) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return this.turn ??= Promise.resolve().then(() => this.advance()).finally(() => { this.turn = undefined; });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.closed) throw new Error('Autonomous learning is closed');
    this.stopping = true;
    try {
      await this.turn;
      if (this.failure) throw this.failure;
      this.state.enabled = enabled; delete this.state.error; await this.persist();
      if (!enabled && this.state.cycle) await this.ports.cancel(structuredClone(this.state.cycle));
    } finally { this.stopping = false; }
  }
  async close(): Promise<void> {
    this.closed = true; await this.turn; await this.ports.store.flush?.();
    // Job and world owners perform shutdown; persisted automation preference is unchanged.
  }

  private async advance(): Promise<void> {
    if (this.stopping || this.closed || !this.state.enabled) return;
    try {
      let cycle = this.state.cycle;
      if (!cycle) {
        if (this.ports.busy()) return;
        const observation = this.ports.observe(this.state.lastObservation);
        if (!observation) return;
        cycle = { ...structuredClone(observation), proposalId: this.ports.id(), evaluationId: this.ports.id() };
        if (!cycle.proposalId || !cycle.evaluationId || cycle.proposalId === cycle.evaluationId) throw new Error('Distinct learning job identities required');
        this.state.cycle = cycle; this.state.lastObservation = structuredClone(observation.mark);
        await this.persist(); // Stable identities and consumed evidence precede any dispatch.
      }
      if (this.stopping || this.closed) return;
      const proposal = this.ports.proposal(cycle.proposalId);
      if (proposal) {
        if (proposal.status === 'activated') { await this.finish('activated'); return; }
        if (['rejected', 'failed', 'cancelled', 'interrupted', 'stale', 'expired'].includes(proposal.status)) {
          await this.finish(proposal.status, proposal.error); return;
        }
        if (this.ports.busy()) return;
        if (proposal.status === 'qualified') {
          if (await this.ports.activate(cycle.proposalId) === 'activated') await this.finish('activated');
          return;
        }
        if (proposal.status === 'proposed') {
          const job = this.ports.job(cycle.evaluationId);
          if (job) { if (terminal(job)) await this.finish(job.status, job.error ?? 'Evaluation finished without a qualified proposal'); return; }
          await this.ports.evaluate(cycle.evaluationId, cycle.proposalId);
        }
        return;
      }
      const job = this.ports.job(cycle.proposalId);
      if (job) { if (terminal(job)) await this.finish(job.status, job.error ?? 'No proposal was published'); return; }
      if (!this.ports.busy()) await this.ports.propose(cycle.proposalId);
    } catch (error) {
      // A journal failure fences dispatch until authoritative storage is reopened.
      if (this.failure) throw this.failure;
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.enabled = false; await this.persist();
    }
  }
  private async finish(status: string, reason?: string): Promise<void> {
    if (status === 'activated' && this.ports.activationObservation) {
      this.state.lastObservation = structuredClone(this.ports.activationObservation(structuredClone(this.state.cycle!.mark)));
    }
    this.state.lastOutcome = { proposalId: this.state.cycle!.proposalId, status, ...(reason ? { reason } : {}) };
    delete this.state.cycle; delete this.state.error; await this.persist();
  }
  private async persist(): Promise<void> {
    try { await this.ports.store.save(this.snapshot()); }
    catch (error) { this.failure = error; throw error; }
  }
}
function terminal(job: AutonomousJob) { return !['queued', 'running', 'cancelling'].includes(job.status); }
