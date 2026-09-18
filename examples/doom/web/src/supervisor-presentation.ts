import type { LearningProposalView, LearningView } from '../../contracts/src/learning.ts';

/** A new review must never be presented as the previous experiment. */
export function visibleSupervisorProposal(data: LearningView | undefined, selected: string): LearningProposalView | undefined {
  if (!data) return;
  if (selected !== 'latest') return data.proposals.find(proposal => proposal.id === selected);
  const current = data.automation?.cycle?.proposalId;
  if (current) return data.proposals.find(proposal => proposal.id === current);
  return data.proposals[0];
}
export function learningResult(reason: string): string {
  if (reason.includes('exceeded the allowed regression')) return 'The change made gameplay worse in at least one test, so it was not applied.';
  if (reason.includes('did not complete every paired scenario')) return 'Some comparison games did not finish, so there is not enough evidence to apply the change.';
  if (/incident|saved.*position/i.test(reason) && /improv|gain/i.test(reason)) return 'The change did not improve the saved problem situation enough to be applied.';
  return reason;
}
export function reviewReason(reason?: string): string {
  if (reason?.includes('Repeated obstructed')) return 'Several plans hit obstacles, could not reach their targets, or ran out of time.';
  if (reason?.includes('No useful progress')) return 'The run has stopped making useful progress.';
  return reason ?? 'The supervisor is checking recent gameplay outcomes for recurring problems.';
}
