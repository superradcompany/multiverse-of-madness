import test from 'node:test';
import assert from 'node:assert/strict';
import type { LearningProposalView, LearningView } from '../../../packages/contracts/src/learning.ts';
import { visibleSupervisorProposal, learningResult, reviewReason } from './supervisor-presentation.ts';
const proposal: LearningProposalView = { id: 'old', status: 'rejected', reason: 'Old idea', changed: ['executor'], createdAt: 1,
  revision: { id: 'revision', version: 'old' }, canEvaluate: false, canActivate: false, stale: true, changes: [] };
const data = { proposals: [proposal], automation: { enabled: true, provider: 'codex', cycle: { proposalId: 'new', evaluationId: 'test', reason: 'A new issue' } } } as LearningView;
test('a pending review never shows the previous rejected attempt as its proposed change', () => {
  assert.equal(visibleSupervisorProposal(data, 'latest'), undefined);
  assert.equal(visibleSupervisorProposal(data, 'old'), proposal);
  const current = { ...proposal, id: 'new', status: 'proposed' };
  assert.equal(visibleSupervisorProposal({ ...data, proposals: [current, proposal] }, 'latest'), current);
  assert.equal(visibleSupervisorProposal({ ...data, automation: undefined }, 'latest'), proposal);
});
test('plain verdicts distinguish a measured regression from an incomplete comparison', () => {
  assert.match(learningResult('Candidate exceeded the allowed regression on a scenario'), /made gameplay worse/);
  assert.match(learningResult('Evaluation did not complete every paired scenario'), /not enough evidence/);
  assert.equal(learningResult('Unknown future reason'), 'Unknown future reason');
  assert.match(reviewReason('Repeated obstructed, unreachable or timed-out plans suggest a missing candidate or route'), /hit obstacles/);
});
