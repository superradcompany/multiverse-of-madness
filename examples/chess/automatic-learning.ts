import { randomUUID } from 'node:crypto';
import { AutonomousLearning, type AutonomousLearningState, type CheckpointStore, type ProposalOrigin, type RevisionController, type VersionRef } from '@multiverse/gameplay-harness';
import { ChessLearningJobs, type ChessLearningJobJournal } from './learning-jobs.ts';
import { observeChessLearning, type ChessLearningEvidence } from './learning-observation.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';

/** Frozen before paid dispatch; retained across process restart by the autonomous journal. */
export interface ChessAutomaticMark { evidence: ChessLearningEvidence; origin: ProposalOrigin }
interface Options {
  binding: VersionRef;
  controller: RevisionController<ChessPolicy>;
  state: CheckpointStore<AutonomousLearningState<ChessAutomaticMark>>;
  jobs: CheckpointStore<ChessLearningJobJournal>;
  snapshot(): ChessSessionCheckpoint;
  context(): VersionRef;
  /** True only between joined gameplay operations, outside an unresolved future batch. */
  ready(): boolean;
  /** Persist generation evidence/results and submit with mark.origin as the expected origin. */
  propose(id: string, mark: ChessAutomaticMark, signal: AbortSignal): Promise<void>;
  recover(): Promise<void>;
  settled(): Promise<void>;
  bootstrap?: boolean;
  enabled?: boolean;
  now?(): number;
  /** Independent regression work runs before new generation, outside the gameplay path. */
  beforeReview?(state: AutonomousLearningState<ChessAutomaticMark>): Promise<boolean>;
}

/** Application-owned wake loop, independent of connected viewers. Paid jobs run outside tick(). */
export class ChessAutomaticLearning {
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private error?: string;
  private turn?: Promise<void>;
  private constructor(private readonly automatic: AutonomousLearning<ChessAutomaticMark>, private readonly jobs: ChessLearningJobs,
    private readonly beforeReview?: Options['beforeReview']) {}
  static async open(options: Options) {
    let automatic: AutonomousLearning<ChessAutomaticMark>;
    const jobs = await ChessLearningJobs.open({ binding: options.binding, store: options.jobs, recover: options.recover, settled: options.settled,
      execute: async (command, signal) => {
        if (command.kind === 'evaluate') { await options.controller.evaluate(command.proposalId, signal); return; }
        const cycle = automatic.snapshot().cycle;
        if (!cycle || cycle.proposalId !== command.id) throw new Error('Chess generation is missing its frozen evidence');
        await options.propose(command.id, structuredClone(cycle.mark), signal);
      },
    });
    let latestGoal: string | undefined, goalChangedAt = 0;
    const now = () => options.now?.() ?? Date.now();
    automatic = await AutonomousLearning.open({ store: options.state, id: randomUUID,
      observe: previous => {
        const snapshot = options.snapshot(), at = now();
        if (latestGoal !== snapshot.objective) { latestGoal = snapshot.objective; goalChangedAt = at; }
        const evidence = observeChessLearning(snapshot, previous?.evidence.mark, { now: at, bootstrap: options.bootstrap, revision: options.controller.active.revision, goalSettled: at - goalChangedAt >= 3000 });
        if (!evidence) return;
        return { reason: evidence.reason, mark: { evidence, origin: { activation: options.controller.active, context: options.context() } } };
      },
      busy: () => jobs.busy || !options.ready(),
      job: id => jobs.snapshot().jobs.find(job => job.command.id === id),
      proposal: id => options.controller.snapshot().proposals.find(proposal => proposal.id === id),
      propose: async id => { await jobs.start({ kind: 'propose', id }); },
      evaluate: async (id, proposalId) => { await jobs.start({ kind: 'evaluate', id, proposalId }); },
      activate: async id => {
        if (!options.ready()) return 'pending';
        return (await options.controller.activate(id)).status === 'activated' ? 'activated' : 'pending';
      },
      activationObservation: previous => {
        const snapshot = options.snapshot(), main = snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!;
        const mark = structuredClone(previous);
        Object.assign(mark.evidence.mark, { attemptedPlies: snapshot.attempts.plies, selectedPlies: main.state.ply, observedAt: now(),
          objective: snapshot.objective, revision: options.controller.active.revision });
        mark.origin = { activation: options.controller.active, context: options.context() }; return mark;
      },
      cancel: async cycle => { await jobs.cancel(cycle.proposalId); await jobs.cancel(cycle.evaluationId); },
    }, options.enabled ?? true);
    return new ChessAutomaticLearning(automatic, jobs, options.beforeReview);
  }
  snapshot() { return { ...this.automatic.snapshot(), jobs: this.jobs.snapshot().jobs, busy: this.jobs.busy, ownerError: this.error }; }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.turn ??= Promise.resolve().then(async () => {
      const state = this.automatic.snapshot();
      if (state.enabled && !state.cycle && !this.jobs.busy && await this.beforeReview?.(state)) return;
      await this.automatic.tick();
    }).finally(() => { this.turn = undefined; });
  }
  async setEnabled(enabled: boolean) { await this.turn; await this.automatic.setEnabled(enabled); }
  /** Call once after the session and learning binding have been attached. */
  start() {
    if (this.closing) throw new Error('Chess automatic learning is closed');
    if (this.timer) return;
    const wake = () => {
      this.timer = setTimeout(() => {
        void this.tick().catch(error => { this.error = error instanceof Error ? error.message : 'Chess automatic learning failed'; })
          .finally(() => { if (!this.closing && !this.error) wake(); });
      }, 500);
      this.timer.unref();
    };
    wake();
  }
  async close() {
    this.closing = true; clearTimeout(this.timer);
    try { await this.turn; await this.automatic.close(); } finally { await this.jobs.close(); }
  }
  /** Intended for controlled shutdown/qualification, not a gameplay or browser wait. */
  async joinJobs() { await this.jobs.join(); }
}
