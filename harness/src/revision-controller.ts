import type { VersionRef } from './contracts.ts';
import type { ProposalOrigin } from './supervisor.ts';
import { SerialQueue } from './execution.ts';
import { revisionCapabilities, type ActivationRef, type LearningRevision, type Qualification, type QualificationRequest, type RevisionJournal, type RevisionPorts, type RevisionProposal, type RevisionRules } from './revisions.ts';
import { activation as validateActivation, artifact, copy, journal, qualification, rules, same, version } from './revision-validation.ts';

/**
 * Single-writer, durable supervisor control plane. It owns the active pointer;
 * candidate code, the evaluator and the user guide remain separate capabilities.
 * Host storage must provide exclusive ownership across processes.
 */
export class RevisionController<Policy> {
  private readonly mutations = new SerialQueue();
  private readonly evaluations = new Map<string, { control: AbortController; promise: Promise<RevisionProposal> }>();
  private poisoned = false;
  private constructor(private state: RevisionJournal<Policy>, private readonly ports: RevisionPorts<Policy>) {}

  static async create<Policy>(initial: LearningRevision<Policy>, limits: RevisionRules, ports: RevisionPorts<Policy>): Promise<RevisionController<Policy>> {
    initial = copy(initial); limits = copy(limits); artifact(initial); rules(limits);
    const controller = new RevisionController<Policy>({ version: 1, rules: limits, initial: copy(initial.revision),
      active: { revision: copy(initial.revision), epoch: 0 }, artifacts: [initial], proposals: [], history: [] }, ports);
    controller.context(); controller.now();
    await ports.verify(copy(initial));
    await controller.publish(controller.state);
    return controller;
  }

  /** Recheck artifacts and history; interrupted evaluations are retained, never automatically replayed. */
  static async restore<Policy>(saved: RevisionJournal<Policy>, limits: RevisionRules, ports: RevisionPorts<Policy>): Promise<RevisionController<Policy>> {
    saved = copy(saved); limits = copy(limits); rules(limits); journal(saved);
    if (!same(saved.rules, limits)) throw new Error('Revision rules changed; explicit journal migration is required');
    const controller = new RevisionController(saved, ports);
    controller.context(); controller.now();
    for (const item of saved.artifacts) await ports.verify(copy(item));
    if (saved.proposals.some(p => p.status === 'evaluating')) {
      const next = copy(saved);
      for (const p of next.proposals) if (p.status === 'evaluating') { p.status = 'interrupted'; p.error = 'Evaluation interrupted by controller restart'; }
      await controller.publish(next);
    }
    return controller;
  }

  /** Copy suitable for diagnostics/persistence. After a publication error, reopen from storage before execution. */
  snapshot(): RevisionJournal<Policy> { return copy(this.state); }
  get active(): ActivationRef { this.usable(); return copy(this.state.active); }
  get current(): LearningRevision<Policy> { this.usable(); return copy(this.find(this.state.active.revision)); }
  get pending(): number { return this.evaluations.size; }

  submit(input: { id: string; candidate: LearningRevision<Policy>; reason: string; expiresAt: number; expected?: ProposalOrigin }): Promise<RevisionProposal> {
    input = copy(input);
    return this.mutations.run(async () => {
      this.usable();
      const createdAt = this.now(); const context = this.context();
      if (input.expected) {
        validateActivation(input.expected.activation); version(input.expected.context);
        if (!same(input.expected.activation, this.state.active) || !same(input.expected.context, context)) throw new Error('Proposal generation baseline or context is stale');
      }
      if (!input.id?.trim() || this.state.proposals.some(p => p.id === input.id)) throw new Error('Proposal identity must be new and nonempty');
      if (!input.reason?.trim() || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= createdAt
        || input.expiresAt - createdAt > this.state.rules.maxLifetimeMs) throw new Error('Invalid proposal reason or lifetime');
      artifact(input.candidate);
      const baseline = this.find(this.state.active.revision);
      if (same(input.candidate.revision, baseline.revision)) throw new Error('Proposal must have a new revision');
      const capabilities = revisionCapabilities.filter(key => !same(baseline[key], input.candidate[key]));
      if (!capabilities.length || capabilities.some(c => !this.state.rules.capabilities.includes(c))) throw new Error('Proposal changes unsupported capabilities');
      const existing = this.state.artifacts.find(a => same(a.revision, input.candidate.revision));
      if (existing && !same(existing, input.candidate)) throw new Error('Immutable artifact identity reused for different content');
      await this.ports.verify(copy(input.candidate));
      if (!same(context, this.context()) || this.now() >= input.expiresAt) throw new Error('Proposal context or lifetime changed during verification');
      const p: RevisionProposal = { id: input.id, basedOn: copy(this.state.active), candidate: copy(input.candidate.revision),
        context, capabilities, reason: input.reason, createdAt, expiresAt: input.expiresAt, status: 'proposed' };
      const next = copy(this.state);
      if (!existing) next.artifacts.push(copy(input.candidate));
      next.proposals.push(p); await this.publish(next);
      return copy(p);
    });
  }

  /** One evaluation per proposal. Slow model/simulation work does not hold the mutation queue. */
  evaluate(id: string, signal?: AbortSignal): Promise<RevisionProposal> {
    this.usable();
    if (this.evaluations.has(id)) throw new Error('Proposal evaluation is already running');
    const control = new AbortController();
    const cancel = () => control.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const promise = this.evaluateProposal(id, control.signal).finally(() => {
      signal?.removeEventListener('abort', cancel); this.evaluations.delete(id);
    });
    this.evaluations.set(id, { control, promise });
    return promise;
  }
  cancel(id: string, reason?: unknown): void { this.evaluations.get(id)?.control.abort(reason); }
  async join(): Promise<void> {
    const results = await Promise.allSettled([...this.evaluations.values()].map(e => e.promise));
    await this.mutations.join();
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** The host fences gameplay, then this controller publishes and exposes one new active pointer. */
  activate(id: string): Promise<RevisionProposal> {
    return this.ports.boundary(() => this.mutations.run(async () => {
      this.usable();
      const next = copy(this.state); const p = this.proposal(next, id);
      if (p.status !== 'qualified') throw new Error('Only a qualified proposal can activate');
      if (this.invalidate(p)) { await this.publish(next); return copy(p); }
      const candidate = this.find(p.candidate); const baseline = this.find(this.state.active.revision);
      await this.ports.verify(copy(candidate));
      await this.ports.compatible(copy(baseline), copy(candidate));
      if (this.invalidate(p)) { await this.publish(next); return copy(p); }
      const at = this.now();
      p.status = 'activated';
      next.active = { revision: copy(p.candidate), epoch: this.nextEpoch() };
      next.history.push({ from: copy(this.state.active), to: copy(next.active), context: copy(p.context), at,
        kind: 'activate', proposalId: p.id, reason: p.reason });
      await this.publish(next);
      return copy(p);
    }));
  }

  /** Only previously active revisions may bypass reevaluation, and state compatibility is still checked. */
  rollback(target: VersionRef, reason: string, expected?: ProposalOrigin): Promise<ActivationRef> {
    target = copy(target); version(target); expected = expected && copy(expected);
    if (expected) { validateActivation(expected.activation); version(expected.context); }
    return this.ports.boundary(() => this.mutations.run(async () => {
      this.usable();
      if (expected && (!same(expected.activation, this.state.active) || !same(expected.context, this.context()))) throw new Error('Rollback evidence baseline or context is stale');
      if (!reason?.trim() || same(target, this.state.active.revision)) throw new Error('Rollback requires a different revision and reason');
      if (!same(target, this.state.initial) && !this.state.history.some(h => same(h.to.revision, target))) throw new Error('Rollback target was never active');
      const context = this.context(); const candidate = this.find(target);
      await this.ports.verify(copy(candidate));
      await this.ports.compatible(copy(this.find(this.state.active.revision)), copy(candidate));
      if (!same(context, this.context())) throw new Error('Rollback context changed during verification');
      const next = copy(this.state);
      next.active = { revision: copy(target), epoch: this.nextEpoch() };
      next.history.push({ from: copy(this.state.active), to: copy(next.active), context, at: this.now(), kind: 'rollback', reason });
      await this.publish(next);
      return copy(next.active);
    }));
  }

  private async evaluateProposal(id: string, signal: AbortSignal): Promise<RevisionProposal> {
    const request = await this.mutations.run(async (): Promise<QualificationRequest<Policy> | undefined> => {
      this.usable();
      const next = copy(this.state); const p = this.proposal(next, id);
      if (p.status !== 'proposed') throw new Error('Proposal has already been evaluated');
      if (this.invalidate(p)) { await this.publish(next); return; }
      if (signal.aborted) { p.status = 'cancelled'; await this.publish(next); return; }
      p.status = 'evaluating'; await this.publish(next);
      return { proposalId: p.id, baseline: copy(this.find(p.basedOn.revision)), candidate: copy(this.find(p.candidate)),
        contract: copy(this.state.rules.contract), context: copy(p.context) };
    });
    if (!request) return copy(this.proposal(this.state, id));
    let result: Qualification | undefined; let error: string | undefined;
    try {
      signal.throwIfAborted();
      await this.ports.verify(copy(request.baseline)); await this.ports.verify(copy(request.candidate));
      signal.throwIfAborted();
      const value = copy(await this.ports.qualify(copy(request), signal));
      qualification(value);
      if (!same(value.baseline, request.baseline.revision) || !same(value.candidate, request.candidate.revision)
        || !same(value.context, request.context) || !same(value.contract, request.contract)) throw new Error('Qualification identity mismatch');
      result = value;
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Qualification failed'; }
    return this.mutations.run(async () => {
      this.usable();
      const next = copy(this.state); const p = this.proposal(next, id);
      if (result) p.qualification = result;
      if (error !== undefined) p.error = error;
      if (!this.invalidate(p)) p.status = signal.aborted ? 'cancelled' : error !== undefined ? 'failed' : result!.accepted ? 'qualified' : 'rejected';
      await this.publish(next); return copy(p);
    });
  }

  private invalidate(p: RevisionProposal): boolean {
    if (!same(p.basedOn, this.state.active) || !same(p.context, this.context())) { p.status = 'stale'; return true; }
    if (this.now() >= p.expiresAt) { p.status = 'expired'; return true; }
    return false;
  }
  private nextEpoch(): number {
    const epoch = this.state.active.epoch + 1;
    if (!Number.isSafeInteger(epoch)) throw new Error('Activation epoch exhausted');
    return epoch;
  }
  private context(): VersionRef { const value = copy(this.ports.context()); version(value); return value; }
  private now(): number {
    const value = this.ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid controller clock');
    return value;
  }
  private find(ref: VersionRef): LearningRevision<Policy> {
    const result = this.state.artifacts.find(a => same(a.revision, ref));
    if (!result) throw new Error('Unknown revision artifact');
    return result;
  }
  private proposal(state: RevisionJournal<Policy>, id: string): RevisionProposal {
    const result = state.proposals.find(p => p.id === id);
    if (!result) throw new Error('Unknown revision proposal');
    return result;
  }
  private usable(): void { if (this.poisoned) throw new Error('Revision publication failed; reopen from authoritative storage before continuing'); }
  private async publish(next: RevisionJournal<Policy>): Promise<void> {
    this.usable(); journal(next);
    try { await this.ports.persist(copy(next)); }
    catch (error) { this.poisoned = true; throw error; }
    this.state = next;
  }
}
