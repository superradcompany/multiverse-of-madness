import { randomUUID } from 'node:crypto';
import { canonicalJson, type CheckpointStore, type EvaluationComparison, type LearningRevision, type RevisionController, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { freezeChessReview, decodeFrozenChessReview, type FrozenChessReview } from './review-input.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import { summarizeChessComparison, type ChessSampleSummary } from './comparison-summary.ts';
import { chessHarnessEvaluator } from './evaluation-contract.ts';

type Report = EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
export interface ChessRegressionAudit {
  id: string; review: FrozenChessReview; baseline: VersionRef;
  status: 'evaluating' | 'pending' | 'retained' | 'rolled-back' | 'stale' | 'interrupted' | 'failed';
  createdAt: number; reason: string; comparison?: VersionRef;
  summary?: ChessSampleSummary;
}
export interface ChessRegressionJournal { version: 1 | 2; binding: VersionRef; audits: ChessRegressionAudit[] }
interface Ports {
  binding: VersionRef; store: CheckpointStore<ChessRegressionJournal>; controller: RevisionController<ChessPolicy>;
  context(): VersionRef; ready(): boolean;
  evaluate(audit: ChessRegressionAudit, baseline: LearningRevision<ChessPolicy>, candidate: LearningRevision<ChessPolicy>, signal: AbortSignal): Promise<Report>;
  read(id: string): Promise<Report | undefined>; write(id: string, report: Report): Promise<void>;
  /** Separate from live preparation resources; join cleanup before completing or admitting another audit. */
  recover(): Promise<void>;
}

/** One check per activation epoch and evaluator version. No generation or paid redispatch on restart. */
export class ChessRegressionAudits {
  private task?: { control: AbortController; done: Promise<void> };
  private turn?: Promise<boolean>;
  private failure?: unknown;
  private closed = false;
  private constructor(private readonly ports: Ports, private readonly state: ChessRegressionJournal) {}
  static async open(ports: Ports) {
    const state = await ports.store.load() ?? { version: 2 as const, binding: ports.binding, audits: [] };
    if (![1, 2].includes(state.version) || !same(state.binding, ports.binding) || !Array.isArray(state.audits)) throw new Error('Invalid chess regression journal');
    const ids = new Set<string>(), scopes = new Set<string>();
    for (const audit of state.audits) {
      decodeFrozenChessReview(audit.review, audit.id);
      const epoch = audit.review.mark.origin.activation.epoch;
      const scope = state.version === 1 ? String(epoch) : auditScope(epoch, audit.review.contract.evaluator);
      if (ids.has(audit.id) || scopes.has(scope) || !Number.isSafeInteger(epoch) || epoch <= 0
        || !['evaluating', 'pending', 'retained', 'rolled-back', 'stale', 'interrupted', 'failed'].includes(audit.status)) throw new Error('Invalid chess regression audit');
      ids.add(audit.id); scopes.add(scope);
    }
    const owner = new ChessRegressionAudits(ports, { ...structuredClone(state), version: 2 });
    await ports.recover();
    for (const audit of owner.state.audits) if (audit.status === 'evaluating') {
      // A complete durable receipt may survive a lost acknowledgment. Never repeat the paid comparison.
      const report = await ports.read(audit.id);
      if (report) { owner.validate(audit, report); audit.comparison = contentRevision('chess-strategy-comparison', report); audit.summary = summarizeChessComparison(report); audit.status = 'pending'; }
      else { audit.status = 'interrupted'; audit.reason = 'Comparison interrupted; no rollback and no automatic redispatch.'; }
    }
    await owner.persist(); return owner;
  }
  get busy() { return this.task !== undefined; }
  snapshot() { return structuredClone(this.state); }
  hasCurrentCheck() {
    const active = this.ports.controller.active, evaluator = chessHarnessEvaluator(this.ports.controller.current.policy);
    return this.state.audits.some(audit => auditScope(audit.review.mark.origin.activation.epoch, audit.review.contract.evaluator) === auditScope(active.epoch, evaluator));
  }
  /** Returns true while this owner has work, so the caller must defer new proposal admission. */
  tick(mark?: ChessAutomaticMark): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.failure) return Promise.reject(this.failure);
    return this.turn ??= this.advance(mark && structuredClone(mark)).finally(() => { this.turn = undefined; });
  }
  async cancel() { this.task?.control.abort(new Error('Chess regression audit cancelled')); await this.task?.done; }
  async close() { this.closed = true; try { await this.turn; } finally { await this.cancel(); await this.ports.store.flush?.(); } }
  async join() { await this.task?.done; if (this.failure) throw this.failure; }
  private async advance(mark?: ChessAutomaticMark): Promise<boolean> {
    if (this.busy) return true;
    const pending = this.state.audits.find(item => item.status === 'pending');
    if (pending) {
      if (!this.ports.ready()) return true;
      const report = await this.ports.read(pending.id);
      if (!report || !same(pending.comparison, contentRevision('chess-strategy-comparison', report))) throw new Error('Chess audit receipt changed');
      this.validate(pending, report);
      const origin = pending.review.mark.origin;
      const history = this.ports.controller.snapshot().history;
      const reason = `Regression audit ${pending.id}: ${pending.comparison!.version}`;
      if (history.some(item => item.kind === 'rollback' && item.reason === reason && same(item.from, origin.activation) && same(item.to.revision, pending.baseline))) {
        pending.status = 'rolled-back'; pending.reason = 'Restored the previous strategy after a measured regression.';
      } else if (!same(origin.activation, this.ports.controller.active) || !same(origin.context, this.ports.context())) {
        pending.status = 'stale'; pending.reason = 'The active strategy or user goal changed; no rollback.';
      } else {
        const outcome = auditRegression(report);
        pending.reason = outcome.reason;
        if (outcome.regressed) {
          // The controller checks origin again inside its publication boundary, including after an async boundary wait.
          try { await this.ports.controller.rollback(pending.baseline, reason, origin); pending.status = 'rolled-back'; }
          catch (error) {
            // A new gameplay task may own the boundary after the receipt read. Keep the result and retry later.
            // Reading active also checks that a failed durable publication has not poisoned the controller.
            if (!same(origin.activation, this.ports.controller.active) || !same(origin.context, this.ports.context())) {
              pending.status = 'stale'; pending.reason = 'The active strategy or user goal changed; no rollback.';
            } else if (!this.ports.ready()) return true;
            else throw error;
          }
        } else pending.status = 'retained';
      }
      await this.persist(); return true;
    }
    if (!mark || !this.ports.ready()) return false;
    const journal = this.ports.controller.snapshot(), origin = mark.origin;
    if (!same(origin.activation, journal.active) || !same(origin.context, this.ports.context())) return false;
    const activation = journal.history.at(-1);
    if (!activation || activation.kind !== 'activate' || this.hasCurrentCheck()) return false;
    const baseline = journal.artifacts.find(item => same(item.revision, activation.from.revision))!;
    const candidate = this.ports.controller.current, id = randomUUID();
    const audit: ChessRegressionAudit = { id, review: freezeChessReview(id, mark, [], candidate.policy), baseline: baseline.revision, status: 'evaluating', createdAt: Date.now(), reason: mark.evidence.reason };
    this.state.audits.push(audit); await this.persist();
    const task = { control: new AbortController(), done: Promise.resolve() };
    this.task = task;
    task.done = this.execute(audit, baseline, candidate, task.control.signal).finally(() => { if (this.task === task) this.task = undefined; });
    void task.done.catch(() => {}); return true;
  }
  private async execute(audit: ChessRegressionAudit, baseline: LearningRevision<ChessPolicy>, candidate: LearningRevision<ChessPolicy>, signal: AbortSignal) {
    try {
      const report = await this.ports.evaluate(structuredClone(audit), baseline, candidate, signal);
      signal.throwIfAborted(); this.validate(audit, report);
      await this.ports.write(audit.id, report);
      audit.comparison = contentRevision('chess-strategy-comparison', report); audit.summary = summarizeChessComparison(report); audit.status = 'pending';
    } catch (error) { audit.status = 'failed'; audit.reason = signal.aborted ? 'Comparison cancelled; no rollback.' : error instanceof Error ? error.message : 'Comparison failed; no rollback.'; }
    try { await this.ports.recover(); await this.persist(); }
    catch (error) { this.failure = error; throw error; }
  }
  private validate(audit: ChessRegressionAudit, report: Report) {
    const activation = this.ports.controller.snapshot().history[audit.review.mark.origin.activation.epoch - 1];
    if (!activation || activation.kind !== 'activate' || !same(activation.to, audit.review.mark.origin.activation)
      || !same(activation.from.revision, audit.baseline)) throw new Error('Chess audit does not reference the activated strategy and its predecessor');
    if (!same(report.contract, audit.review.contract) || !same(report.candidate, audit.review.mark.origin.activation.revision)
      || !same(report.baseline, audit.baseline)) throw new Error('Chess audit comparison identity differs from its frozen contract');
  }
  private async persist() {
    try { await this.ports.store.save(this.snapshot()); }
    catch (error) { this.failure = error; throw error; }
  }
}

/** A failed improvement threshold is not proof of a regression. Partial/error runs never cause rollback. */
export function auditRegression(report: Report): { regressed: boolean; reason: string } {
  const { contract } = report;
  if (report.runs.length !== contract.scenarios.length * 2 || report.runs.some(run => run.status !== 'complete')) return { regressed: false, reason: 'Comparison incomplete; kept the current strategy.' };
  if (report.runs.some(run => run.evidence?.after.status === 'ongoing'
    && run.evidence.after.ply - run.evidence.before.ply < contract.scenarios.find(scenario => scenario.id === run.scenarioId)!.input.plies)) return { regressed: false, reason: 'Comparison stopped short of its scoring horizon; kept the current strategy.' };
  if (contract.scenarios.some(scenario => scenario.input.sample)) {
    const summary = summarizeChessComparison(report);
    const regression = summary.positions.find(position => position.completed === position.planned
      && position.mean! < -contract.acceptance.maximumCaseRegression && position.worse > position.planned / 2);
    return regression ? { regressed: true, reason: `Restored the previous strategy: ${regression.worse}/${regression.planned} paired runs were worse at a position (mean ${regression.mean!.toFixed(2)} ${contract.acceptance.metric}).` }
      : { regressed: false, reason: 'Repeated comparisons did not show a consistent regression; kept the current strategy.' };
  }
  let worst = 0;
  for (const scenario of contract.scenarios) {
    const pair = report.runs.filter(run => run.scenarioId === scenario.id);
    const before = pair.filter(run => run.role === 'baseline'), after = pair.filter(run => run.role === 'candidate');
    if (pair.length !== 2 || before.length !== 1 || after.length !== 1) throw new Error('Invalid chess audit pair');
    const a = before[0]!.metrics?.[contract.acceptance.metric], b = after[0]!.metrics?.[contract.acceptance.metric];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Missing chess audit metrics');
    const gain = (b - a) * (contract.acceptance.direction === 'maximize' ? 1 : -1);
    worst = Math.min(worst, gain);
  }
  const regressed = worst < -contract.acceptance.maximumCaseRegression;
  return { regressed, reason: regressed ? `Restored the previous strategy: a complete paired comparison regressed by ${-worst} ${contract.acceptance.metric} points.` : 'No measured regression; kept the current strategy.' };
}
function same(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
function auditScope(epoch: number, evaluator: VersionRef) { return canonicalJson({ epoch, evaluator }); }
