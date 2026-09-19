import { canonicalJson, type EvaluationComparison, type RevisionJournal, type TrainingSelection, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import type { ChessPolicy } from './session-types.ts';

export interface ChessTrainingReport {
  format: 1; purpose: 'practice'; selection: TrainingSelection;
  comparison: EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
}
export interface ChessTrainingFeedback {
  purpose: 'practice'; candidate: VersionRef; objective: string; reason: string;
  results: Array<{ scenarioId: string; gain?: number; complete: boolean }>;
}

/** Read only practice receipts referenced by a completed qualification, never treat them as acceptance. */
export async function chessTrainingFeedback(journal: RevisionJournal<ChessPolicy>, read: (id: string) => Promise<unknown>): Promise<ChessTrainingFeedback[]> {
  const feedback: ChessTrainingFeedback[] = [];
  for (const proposal of [...journal.proposals].reverse()) {
    const qualification = proposal.qualification;
    const reference = (qualification?.evidence as { training?: VersionRef } | undefined)?.training;
    if (!reference || !qualification) continue;
    const report = await read(proposal.id) as ChessTrainingReport;
    if (!report || report.format !== 1 || report.purpose !== 'practice'
      || canonicalJson(reference) !== canonicalJson(contentRevision('chess-training-report', report))
      || canonicalJson(report.comparison.baseline) !== canonicalJson(qualification.baseline)
      || canonicalJson(report.comparison.candidate) !== canonicalJson(qualification.candidate)) throw new Error('Chess practice feedback differs from its recorded qualification');
    feedback.push({ purpose: 'practice', candidate: { ...report.comparison.candidate }, objective: report.comparison.contract.scenarios[0]!.input.objective,
      reason: report.selection.reason, results: report.selection.scenarioIds.map(scenarioId => {
        const runs = report.comparison.runs.filter(run => run.scenarioId === scenarioId), gain = report.comparison.gains.find(pair => pair.scenarioId === scenarioId)?.gain;
        return { scenarioId, complete: runs.length === 2 && runs.every(run => run.status === 'complete'), ...(gain === undefined ? {} : { gain }) };
      }) });
    if (feedback.length === 2) break;
  }
  return feedback;
}
