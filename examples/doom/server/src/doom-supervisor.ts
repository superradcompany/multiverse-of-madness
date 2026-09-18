import type { DoomHistoricalResolver } from './doom-learning-history.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, RevisionController, type CheckpointStore, type LearningRevision, type ProposalOrigin,
  type Qualification, type QualificationRequest, type RevisionJournal, type RevisionRules, type VersionRef } from '@multiverse/gameplay-harness';
import { doomLearningBinding, type DoomLearningBinding } from './doom-learning.ts';
import type { DoomLearningModels } from './doom-learning-models.ts';
import type { DoomPolicy } from './doom-policy.ts';
import type { Session } from './session.ts';

export interface SavedDoomSupervisor { version: 1; identity: VersionRef; journal: RevisionJournal<DoomPolicy> }
const savedSchema = z.strictObject({ version: z.literal(1),
  identity: z.strictObject({ id: z.literal('doom-supervisor'), version: z.string().uuid() }), journal: z.unknown() });

/** The shared controller validates the full nested journal and every artifact during open. */
export function decodeDoomSupervisor(value: unknown): SavedDoomSupervisor {
  const parsed = savedSchema.parse(value);
  return { ...parsed, journal: parsed.journal as RevisionJournal<DoomPolicy> };
}

export interface DoomSupervisorOptions {
  historical?: DoomHistoricalResolver;
  /** The host must exclusively own this store across processes, just like the game session store. */
  store: CheckpointStore<SavedDoomSupervisor>;
  models: DoomLearningModels;
  rules: RevisionRules;
  /** Trusted host evaluator; proposal data never supplies its metric, scenarios or budget. */
  qualify(request: QualificationRequest<DoomPolicy>, signal: AbortSignal): Promise<Qualification>;
  /** Required only when creating a new journal. Never used to replace an existing journal. */
  initial?: LearningRevision<DoomPolicy>;
  /** Required by the caller reopening a format-2 game session. */
  expectedBinding?: VersionRef;
}

/** Server-owned durable control plane. Opening it does not adopt, resume or change a game. */
export class DoomSupervisor {
  readonly binding: DoomLearningBinding;
  private session?: Session;
  private closed = false;
  private adoption?: Promise<void>;
  private closing?: Promise<void>;
  private overviewJournal!: RevisionJournal<DoomPolicy>;
  private constructor(private readonly controller: RevisionController<DoomPolicy>, identity: VersionRef,
    private readonly options: DoomSupervisorOptions) {
    const binding = doomLearningBinding(controller, identity, artifact => options.models.model(artifact), options.historical);
    const resolved = new Map<string, LearningRevision<DoomPolicy>>();
    this.binding = { ...binding, resolve: activation => {
      // A validated activation identifies immutable contents. Rechecking the same
      // epoch must not recopy every past experiment on every gameplay decision.
      const key = canonicalJson(activation);
      let artifact = resolved.get(key);
      if (!artifact) {
        artifact = binding.resolve(activation);
        resolved.set(key, artifact);
        if (resolved.size > 64) resolved.delete(resolved.keys().next().value!);
      }
      return structuredClone(artifact);
    } };
  }

  static async open(options: DoomSupervisorOptions): Promise<DoomSupervisor> {
    options = { ...options, rules: structuredClone(options.rules), initial: structuredClone(options.initial), expectedBinding: structuredClone(options.expectedBinding) };
    const savedValue = await options.store.load();
    const saved = savedValue === undefined ? undefined : decodeDoomSupervisor(savedValue);
    if (options.expectedBinding && (!saved || !same(saved.identity, options.expectedBinding))) throw new Error('Missing or mismatched Doom supervisor journal');
    if (!saved && !options.initial) throw new Error('A new Doom supervisor requires an explicit baseline');
    const identity: VersionRef = saved?.identity ?? { id: 'doom-supervisor', version: randomUUID() };
    let owner: DoomSupervisor | undefined;
    let overviewJournal: RevisionJournal<DoomPolicy>;
    const ports = {
      context: () => owner?.session?.supervisorContext() ?? { id: 'unattached-doom-supervisor', version: identity.version },
      boundary: <T>(work: () => Promise<T>) => owner!.boundSession().revisionBoundary(work),
      compatible: async (_before: LearningRevision<DoomPolicy>, candidate: LearningRevision<DoomPolicy>) => {
        owner!.boundSession().validateLearningRevision(candidate);
      },
      verify: (artifact: LearningRevision<DoomPolicy>) => options.models.verify(artifact),
      qualify: (request: QualificationRequest<DoomPolicy>, signal: AbortSignal) => { owner!.boundSession(); return options.qualify(request, signal); },
      persist: async (journal: RevisionJournal<DoomPolicy>) => {
        await options.store.save({ version: 1, identity, journal });
        // Publish the small observer projection only after durable publication.
        // Historical evaluation traces can be megabytes; polling must not walk them.
        overviewJournal = supervisorOverview(journal);
        if (owner) owner.overviewJournal = overviewJournal;
      },
    };
    const controller = saved ? await RevisionController.restore(saved.journal, options.rules, ports)
      : await RevisionController.create(options.initial!, options.rules, ports);
    owner = new DoomSupervisor(controller, identity, options);
    owner.overviewJournal = overviewJournal! ?? supervisorOverview(saved!.journal);
    return owner;
  }

  /** Attach only after initialize/restore has succeeded. The binding must already be in the game checkpoint. */
  attach(session: Session): void {
    this.usable();
    if (this.adoption) throw new Error('Doom supervisor adoption is in progress');
    this.attachSession(session);
  }
  private attachSession(session: Session): void {
    if (this.session && this.session !== session) throw new Error('Doom supervisor already has a session');
    if (!same(session.checkpoint().learning?.binding, this.binding.identity)) throw new Error('Doom session has not adopted this supervisor');
    session.validateLearningRevision(this.controller.current);
    this.session = session;
  }

  /** Explicit legacy adoption; a journal from a different supervised run cannot be attached by accident. */
  adopt(session: Session): Promise<void> {
    this.usable();
    if (this.session || this.adoption) throw new Error('Doom supervisor already has a session or adoption in progress');
    const saved = this.controller.snapshot();
    if (saved.active.epoch !== 0 || saved.history.length || saved.proposals.length) throw new Error('Legacy adoption requires an unused supervisor journal');
    this.adoption = (async () => {
      await session.adoptLearning(this.binding);
      this.attachSession(session);
    })();
    // Keep the settled promise until close. An ambiguous adoption failure must be reopened, never retried on another game.
    return this.adoption;
  }

  snapshot(): SavedDoomSupervisor {
    this.usable();
    // Also check publication health; snapshot alone is diagnostic and does not do that.
    this.controller.active;
    return { version: 1, identity: structuredClone(this.binding.identity), journal: this.controller.snapshot() };
  }

  /** Read-only status projection. Full qualification evidence remains in snapshot/storage. */
  overview(): SavedDoomSupervisor {
    this.usable(); this.controller.active;
    return { version: 1, identity: structuredClone(this.binding.identity), journal: structuredClone(this.overviewJournal) };
  }

  origin(): ProposalOrigin { return { activation: this.controller.active, context: this.boundSession().supervisorContext() }; }
  submit(input: { id: string; candidate: LearningRevision<DoomPolicy>; reason: string; expiresAt: number; expected: ProposalOrigin }) {
    this.boundSession(); return this.controller.submit(input);
  }
  evaluate(id: string, signal?: AbortSignal) { this.boundSession(); return this.controller.evaluate(id, signal); }
  activate(id: string) { this.boundSession(); return this.controller.activate(id); }
  rollback(target: VersionRef, reason: string) { this.boundSession(); return this.controller.rollback(target, reason); }
  cancel(id: string) { this.usable(); this.controller.cancel(id, new Error('Evaluation cancelled by user')); }

  /** Caller pauses gameplay first. Join evaluator cleanup before releasing store ownership. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    for (const proposal of this.controller.snapshot().proposals) if (proposal.status === 'evaluating') this.controller.cancel(proposal.id, new Error('Doom supervisor closing'));
    try {
      const results = await Promise.allSettled([this.controller.join(), this.adoption]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally { await this.options.store.flush?.(); }
  }

  private usable(): void { if (this.closed) throw new Error('Doom supervisor is closed'); }
  private boundSession(): Session {
    this.usable();
    if (!this.session || !same(this.session.checkpoint().learning?.binding, this.binding.identity)) throw new Error('Doom supervisor is not attached to its session');
    return this.session;
  }
}
function supervisorOverview(journal: RevisionJournal<DoomPolicy>): RevisionJournal<DoomPolicy> {
  return structuredClone({ ...journal, proposals: journal.proposals.map(proposal => {
    if (!proposal.qualification) return proposal;
    const evidence = proposal.qualification.evidence as { meanGain?: number; gains?: Array<{ gain: number }> } | null;
    return { ...proposal, qualification: { ...proposal.qualification, evidence: {
      meanGain: evidence?.meanGain, gains: evidence?.gains?.map(({ gain }) => ({ gain })),
    } } };
  }) });
}
function same(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b); }
