import { canonicalJson, type CheckpointStore, type EvaluationComparison, type EvaluationContract, type EvaluationRun } from '@multiverse/gameplay-harness';
import { ChessWorld, type ChessState } from './runtime.ts';
import { summarizeChessComparison, type ChessSampleSummary } from './comparison-summary.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import type { ChessHarnessEvidence } from './harness-evaluation.ts';

type Report = EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
export interface ChessEvaluationProgress {
  scenarioId: string; role: 'baseline' | 'candidate'; before: ChessState; state: ChessState;
  attemptedPlies: number; trials: Array<{ label: string; state: ChessState }>;
}
export interface ChessEvaluationObserver {
  start(contract: EvaluationContract<ChessStrategyScenario>): Promise<void>;
  progress(value: ChessEvaluationProgress): Promise<void>;
  run(value: EvaluationRun<ChessStrategyEvaluationEvidence>): Promise<void>;
  finish(report: Report): Promise<void>;
  failed(): Promise<void>;
}
export interface ChessComparisonView {
  version: 1; id: string; kind: 'proposal' | 'audit'; status: 'running' | 'finished' | 'interrupted'; reason?: string;
  runs: Array<{ scenarioId: string; label: string; role: 'baseline' | 'candidate'; status: 'waiting' | 'running' | EvaluationRun<unknown>['status'];
    targetPlies: number; attemptedPlies: number; frames: ChessState[]; trials: ChessEvaluationProgress['trials']; value?: number; scoredPlies?: number }>;
  summary?: ChessSampleSummary;
}

/** Presentation cache only. Never used for qualification, activation or supervisor feedback. */
export class ChessComparisonViewer {
  private value?: ChessComparisonView;
  private constructor(private readonly store: CheckpointStore<ChessComparisonView>) {}
  static async open(store: CheckpointStore<ChessComparisonView>) {
    const viewer = new ChessComparisonViewer(store);
    let saved: ChessComparisonView | undefined;
    try { saved = await store.load(); } catch { return viewer; }
    if (saved) {
      if (saved.version !== 1 || !saved.id || !['proposal', 'audit'].includes(saved.kind) || !Array.isArray(saved.runs)) return viewer;
      viewer.value = structuredClone(saved);
      if (viewer.value.status === 'running') {
        viewer.value.status = 'interrupted'; viewer.value.reason = 'Testing stopped. Recorded positions remain available; no comparison is being rerun.';
        for (const run of viewer.value.runs) if (run.status === 'running') run.status = 'cancelled';
      }
    }
    return viewer;
  }
  snapshot() { return this.value && structuredClone(this.value); }
  summary() { const value = this.value; return value ? { id: value.id, kind: value.kind, status: value.status,
    completed: value.runs.filter(run => run.status === 'complete').length, total: value.runs.length } : undefined; }
  observer(id: string, kind: ChessComparisonView['kind']): ChessEvaluationObserver {
    const current = () => this.value?.id === id && this.value.kind === kind ? this.value : undefined;
    return {
      start: async contract => {
        const positions = new Map<string, number>(), runs: ChessComparisonView['runs'] = [];
        for (const scenario of contract.scenarios) {
          const key = scenario.input.sample?.id ?? scenario.id;
          if (!positions.has(key)) positions.set(key, positions.size + 1);
          const label = `Position ${positions.get(key)}${scenario.input.sample ? ` · sample ${scenario.input.sample.index + 1}` : ''}`;
          const world = new ChessWorld('comparison-start', scenario.input.saved);
          let state: ChessState; try { state = await world.state(); } finally { await world.destroy(); }
          for (const role of ['baseline', 'candidate'] as const) runs.push({ scenarioId: scenario.id, label, role, status: 'waiting', targetPlies: scenario.input.plies, attemptedPlies: 0, frames: [state], trials: [] });
        }
        this.value = { version: 1, id, kind, status: 'running', runs }; await this.persist();
      },
      progress: async progress => {
        const value = current(), run = value?.runs.find(run => run.scenarioId === progress.scenarioId && run.role === progress.role);
        if (!run) return;
        run.frames = await frames(progress.before, progress.state); run.status = 'running';
        run.attemptedPlies = progress.attemptedPlies; run.trials = structuredClone(progress.trials); await this.persist();
      },
      run: async result => {
        const run = current()?.runs.find(run => run.scenarioId === result.scenarioId && run.role === result.role);
        if (!run) return;
        if (result.evidence) {
          run.frames = await frames(result.evidence.before, result.evidence.after); run.scoredPlies = result.evidence.after.ply - result.evidence.before.ply;
          run.attemptedPlies = (result.evidence as Partial<ChessHarnessEvidence>).harness?.attempts.plies ?? result.evidence.moves.length;
        }
        run.status = result.status; run.value = result.metrics?.value; run.trials = []; await this.persist();
      },
      finish: async report => {
        const value = current(); if (!value) return;
        value.status = 'finished'; value.reason = report.reason; value.summary = summarizeChessComparison(report); await this.persist();
      },
      failed: async () => { const value = current(); if (value) { value.status = 'interrupted'; value.reason = 'Testing stopped; recorded positions remain available.'; await this.persist(); } },
    };
  }
  /** Restore a verified historical receipt without advancing a live world or making model calls. */
  async restoreReport(id: string, kind: ChessComparisonView['kind'], report: Report) {
    try {
      const observer = this.observer(id, kind); await observer.start(report.contract);
      for (const run of report.runs) await observer.run(run);
      await observer.finish(report);
    } catch { this.value = undefined; } // The authoritative report is intact; an unavailable preview cannot stop a session.
  }
  async close() { try { await this.store.flush?.(); } catch { /* A presentation-cache failure cannot prevent runtime cleanup. */ } }
  private async persist() { if (this.value) await this.store.save(this.snapshot()!); }
}
async function frames(before: ChessState, after: ChessState): Promise<ChessState[]> {
  if (before.initialFen !== after.initialFen || canonicalJson(after.moves.slice(0, before.ply)) !== canonicalJson(before.moves)) throw new Error('Comparison path does not continue its starting history');
  const world = new ChessWorld('comparison-replay', before), result: ChessState[] = [];
  try {
    const initial = await world.state();
    if (canonicalJson(initial) !== canonicalJson(before)) throw new Error('Comparison starting board differs from its recorded history');
    result.push(initial);
    for (const san of after.moves.slice(before.ply)) result.push(await world.step({ san }));
    if (canonicalJson(await world.state()) !== canonicalJson(after)) throw new Error('Comparison replay differs from the observed board');
    return result;
  } finally { await world.destroy(); }
}
