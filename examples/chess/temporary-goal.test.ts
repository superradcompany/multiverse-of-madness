import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessWorld } from './runtime.ts';
import { ChessAdapter } from './adapter.ts';
import { chessGoalFrame, advanceChessTemporaryGoal, proposeChessTemporaryGoal, type ChessGoalContext, type ChessGoalProposal } from './temporary-goal.ts';
import { prepareChessRequest, type ChessDecisionRequest } from './preparation.ts';
import { chessQuestion } from './jev.ts';
import { decideChess } from './decision.ts';

const proposal: ChessGoalProposal = { key: 'developKnight', instruction: 'Develop a knight toward f3', reason: 'Use a legal development route', evidence: ['current-state'], duration: 4, target: { kind: 'occupy', square: 'f3', piece: 'n' } };
async function fixture() {
  const world = new ChessWorld('goal'), state = await world.state();
  const context: ChessGoalContext = { player: 'w', frame: chessGoalFrame({ scopeId: 'test-run', state, player: 'w', objective: 'Play without sacrifices', source: { id: 'strategy', version: '1' } }) };
  const request: ChessDecisionRequest = { state, objective: 'Play without sacrifices', candidates: await new ChessAdapter().candidates(state), experience: [], revision: { id: 'strategy', version: '1' }, temporaryGoal: context };
  const output = { abi: 'chess-preparation/2', guidance: '', plans: request.candidates.map(plan => ({ id: plan.id, label: plan.label, expectedBenefit: plan.expectedBenefit })), experienceIndices: [], temporaryGoal: proposal };
  return { world, state, context, request, output };
}
test('chess goals complete from board facts and forks do not share outcomes or renew deadlines', async () => {
  const f = await fixture(), parent = proposeChessTemporaryGoal(proposal, f.context, f.state)!;
  const [left, right] = await f.world.branch(['left', 'right']);
  const reached = await left!.step({ san: 'Nf3' }), missed = await right!.step({ san: 'd4' });
  const now = { ...f.context.frame, clock: { unit: 'chess-plies', value: 1 } };
  assert.equal(advanceChessTemporaryGoal(parent, now, reached, 'w').record.status, 'completed');
  assert.equal(advanceChessTemporaryGoal(parent, now, missed, 'w').record.status, 'active');
  assert.equal(parent.record.status, 'active');
  const again = proposeChessTemporaryGoal({ ...proposal, duration: 20 }, { ...f.context, current: parent }, f.state)!;
  assert.equal(again.record.id, parent.record.id); assert.equal(again.record.expiresAt, 4);
  const expired = advanceChessTemporaryGoal(parent, { ...now, clock: { unit: 'chess-plies', value: 4 } }, reached, 'w');
  assert.equal(expired.record.status, 'expired');
  for (const key of ['scope', 'context', 'source'] as const) assert.equal(advanceChessTemporaryGoal(parent, { ...now, [key]: { id: 'changed', version: '2' } }, f.state, 'w').record.status, 'invalidated');
});
test('only controlled-side Jev decisions receive temporary guidance and the user objective stays primary', async () => {
  const f = await fixture(), prepared = prepareChessRequest(f.output, f.request);
  const wire = chessQuestion(prepared, { model: 'test', player: 'w', maxCalls: null });
  assert.equal((wire.state as any).temporaryGoal.instruction, proposal.instruction);
  assert.equal((wire.state as any).userObjective, f.request.objective);
  assert.match((wire.questions.move.instructions as any).temporaryGoal, /Respect userObjective first/);
  const opponent = await f.world.step({ san: 'e4' });
  const opponentRequest = { ...prepared, state: opponent, candidates: await new ChessAdapter().candidates(opponent) };
  assert.equal((chessQuestion(opponentRequest, { model: 'test', player: 'w', maxCalls: null }).state as any).temporaryGoal, undefined);
  const maliciousNew = proposeChessTemporaryGoal({ ...proposal, key: 'helpWhite', target: { kind: 'checkmate' } }, { ...f.context, current: prepared.temporaryGoal!.current }, opponent);
  assert.equal(maliciousNew!.key, 'developKnight');
  assert.throws(() => prepareChessRequest({ ...f.output, abi: 'chess-preparation/1' }, f.request));
  assert.throws(() => prepareChessRequest({ ...f.output, temporaryGoal: { ...proposal, duration: 0 } }, f.request));
});
test('preparation cannot replace the host goal scope before a decision', async () => {
  const f = await fixture();
  await assert.rejects(decideChess({ version: { id: 'fixture', version: '1' }, prepare: async request => ({ ...request, temporaryGoal: { ...f.context, player: 'b' } }), decide: async () => assert.fail('Do not ask Jev') }, f.request, new AbortController().signal), /goal scope/);
});

test('opponent preparation cannot drop the controlled-side pursuit to renew it next turn', async () => {
  const f = await fixture(), prepared = prepareChessRequest(f.output, f.request), state = await f.world.step({ san: 'e4' });
  const request = { ...prepared, state, candidates: await new ChessAdapter().candidates(state), temporaryGoal: {
    ...prepared.temporaryGoal!, frame: { ...f.context.frame, clock: { unit: 'chess-plies', value: state.ply } },
  } };
  await assert.rejects(decideChess({ version: { id: 'fixture', version: '1' }, prepare: async input => ({ ...input, temporaryGoal: { frame: input.temporaryGoal!.frame, player: 'w' } }), decide: async () => assert.fail('Do not ask Jev') }, request, new AbortController().signal), /Opponent preparation/);
});
