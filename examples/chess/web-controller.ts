import type { ChessLearningHost } from './learning-host.ts';
import type { ChessSession } from './session.ts';

/** Owns the browser play loop; disconnecting a viewer does not pause the game. */
export class ChessWebController {
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private running = false;
  private error?: string;
  constructor(readonly session: ChessSession, private readonly intervalMs = 1000, readonly learning?: Pick<ChessLearningHost, 'view' | 'setEnabled' | 'comparison'>) {}
  view() {
    const saved = this.session.snapshot();
    const offset = saved.games?.attemptsAtStart ?? { plies: 0, decisions: 0, forks: 0, rollbacks: 0 };
    const ids = new Set([saved.mainId, ...(saved.batch?.ids ?? [])]);
    return { running: this.running, busy: Boolean(this.task), error: this.error,
      learning: this.learning?.view(), mainId: saved.mainId, objective: saved.objective, policy: saved.policy, model: saved.provenance.model.id,
      comparison: saved.batch ? { complete: saved.batch.complete, plies: saved.batch.plies } : undefined,
      worlds: saved.worlds.filter(world => ids.has(world.meta.id)).map(world => ({ id: world.meta.id, label: world.label, state: world.state, ...(world.temporaryGoal ? { temporaryGoal: world.temporaryGoal } : {}), statistics: world.statistics })),
      checkpoints: saved.points.points.map(point => ({ id: point.id, ply: point.data.state.ply })),
      attempts: { plies: saved.attempts.plies - offset.plies, decisions: saved.attempts.decisions - offset.decisions,
        forks: saved.attempts.forks - offset.forks, rollbacks: saved.attempts.rollbacks - offset.rollbacks },
      completedGames: (saved.games?.completed ?? []).map(game => ({ endpointId: game.endpointId, finishedAt: game.finishedAt, status: game.state.status, plies: game.state.ply })),
      experienceCount: saved.experiences.length };
  }
  async step() { this.idle(); await this.execute(() => this.session.step()); }
  play() {
    this.idle(); this.running = true; this.schedule(0);
  }
  async pause() {
    this.running = false; clearTimeout(this.timer);
    await this.session.pause(); await this.task;
  }
  async guide(text: string) { this.idle(); await this.execute(() => this.session.guide(text)); }
  async rollback(id: string) { this.idle(); await this.execute(() => this.session.rollback(id)); }
  async newGame(expectedMainId: string) {
    this.idle();
    const view = this.view();
    if (view.mainId !== expectedMainId || view.comparison || view.worlds.find(world => world.id === view.mainId)?.state.status === 'ongoing') throw new Error('Only the current finished game can be restarted');
    await this.execute(() => this.session.newGame(expectedMainId));
  }
  async learningBoundary<T>(work: () => Promise<T>): Promise<T> {
    if (this.task) throw new Error('A chess operation is already in progress');
    let result!: T;
    await this.execute(async () => { result = await this.session.revisionBoundary(work); });
    return result;
  }
  async close() { await this.pause(); await this.session.detach(); }
  private idle() {
    if (this.running || this.task) throw new Error('Pause playback before changing the session');
    if (this.error) throw new Error('Restart the chess server to recover the failed operation');
  }
  private execute(work: () => Promise<void>) {
    this.task = Promise.resolve().then(work).catch(error => {
      this.error = error instanceof Error ? error.message : 'Chess operation failed'; this.running = false;
      throw error;
    }).finally(() => { this.task = undefined; });
    return this.task;
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      if (this.task) { this.schedule(this.intervalMs); return; }
      const view = this.view(), main = view.worlds.find(world => world.id === view.mainId)!;
      if (!view.comparison && main.state.status !== 'ongoing') { this.running = false; return; }
      void this.execute(() => this.session.step()).then(() => { if (this.running) this.schedule(this.intervalMs); }).catch(() => {});
    }, delay);
  }
}
export type ChessWebView = ReturnType<ChessWebController['view']>;
