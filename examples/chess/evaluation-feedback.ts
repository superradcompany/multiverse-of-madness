import { canonicalJson, type EvaluationComparison, type RevisionJournal, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { ChessPolicy } from './session-types.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import type { ChessRegressionJournal } from './regression-audits.ts';
import { summarizeChessComparison, type ChessSampleSummary } from './comparison-summary.ts';

export interface ChessStrategyFeedback {
  candidate: VersionRef; objective: string; metric: string; accepted: boolean; reason: string; pairedGains: number[];
  runs: Array<{ role: 'baseline' | 'candidate'; status: string; metrics?: Record<string, number>; error?: string }>;
  samples?: ChessSampleSummary;
}
/** Read only controller-qualified reports. Keep private test positions, moves and seeds out of proposals. */
export async function chessEvaluationFeedback(journal: RevisionJournal<ChessPolicy>,
  read: (proposalId: string) => Promise<unknown>): Promise<ChessStrategyFeedback[]> {
  const results: ChessStrategyFeedback[] = [];
  for (const proposal of [...journal.proposals].reverse()) {
    const qualification = proposal.qualification;
    if (!qualification) continue;
    const evidence = qualification.evidence as { comparison?: VersionRef };
    if (!evidence?.comparison) continue;
    const report = await read(proposal.id) as EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
    if (!report || canonicalJson(contentRevision('chess-strategy-comparison', report)) !== canonicalJson(evidence.comparison)
      || canonicalJson(report.candidate) !== canonicalJson(qualification.candidate)
      || canonicalJson(report.baseline) !== canonicalJson(qualification.baseline)
      || report.accepted !== qualification.accepted) throw new Error('Chess evaluation feedback does not match its qualified report');
    results.push(chessComparisonFeedback(report));
    if (results.length === 2) break;
  }
  return results;
}
export async function chessAuditFeedback(journal: ChessRegressionJournal, read: (id: string) => Promise<unknown>): Promise<ChessStrategyFeedback[]> {
  const results: ChessStrategyFeedback[] = [];
  for (const audit of [...journal.audits].reverse()) {
    if (!audit.comparison) continue;
    const report = await read(audit.id) as EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>;
    if (!report || canonicalJson(contentRevision('chess-strategy-comparison', report)) !== canonicalJson(audit.comparison)
      || canonicalJson(report.candidate) !== canonicalJson(audit.review.mark.origin.activation.revision)
      || canonicalJson(report.baseline) !== canonicalJson(audit.baseline)
      || canonicalJson(report.contract) !== canonicalJson(audit.review.contract)) throw new Error('Chess audit feedback does not match its recorded report');
    results.push(chessComparisonFeedback(report));
    if (results.length === 2) break;
  }
  return results;
}
function chessComparisonFeedback(report: EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>): ChessStrategyFeedback {
    const samples = report.contract.scenarios.some(scenario => scenario.input.sample) ? summarizeChessComparison(report) : undefined;
    return { candidate: { ...report.candidate }, objective: report.contract.scenarios[0]!.input.objective, metric: report.contract.acceptance.metric, accepted: report.accepted, reason: report.reason,
      pairedGains: report.gains.map(pair => pair.gain),
      ...(samples ? { samples } : {}),
      runs: samples ? [] : report.runs.map(run => ({ role: run.role, status: run.status, ...(run.metrics ? { metrics: structuredClone(run.metrics) } : {}),
        // Raw executor errors can contain test state; provide a generic failure category instead.
        ...(run.error ? { error: 'Run failed; this is not evidence of improved play.' } : {}) })),
    };
}
