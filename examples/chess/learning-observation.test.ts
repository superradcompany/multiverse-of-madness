import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessWorld } from './runtime.ts';
import { observeChessLearning } from './learning-observation.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chess-observe-'));
  const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime')), new ChessAdapter(), new ChessFixtureModel());
  const snapshot = session.snapshot(); await session.detach(); await rm(root, { recursive: true, force: true });
  return snapshot;
}
async function played(base: ChessSessionCheckpoint, moves: string[]) {
  const snapshot = structuredClone(base), world = snapshot.worlds.find(w => w.meta.id === snapshot.mainId)!;
  const runtime = new ChessWorld('fixture');
  for (const move of moves) await runtime.step({ san: move });
  world.state = await runtime.state(); snapshot.attempts.plies = moves.length;
  await runtime.destroy(); return snapshot;
}

test('chess reviews require actual gameplay evidence, coalesce polling, and capture exact pre-loop history', async () => {
  const base = await fixture(), now = 1000000;
  assert.equal(observeChessLearning(base, undefined, { now, bootstrap: true }), undefined);
  const healthy = await played(base, ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal(observeChessLearning(healthy, undefined, { now }), undefined);
  const bootstrap = observeChessLearning(healthy, undefined, { now, bootstrap: true })!;
  assert.equal(bootstrap.mark.issue, 'bootstrap'); assert.equal(bootstrap.observations.length, 4);
  assert.equal(observeChessLearning(healthy, bootstrap.mark, { now: now + 600000, bootstrap: true }), undefined);
  const repeat = await played(base, ['Nf3', 'Nf6', 'Ng1', 'Ng8']);
  const review = observeChessLearning(repeat, undefined, { now })!;
  assert.equal(review.mark.issue, 'repetition'); assert.equal(review.incident.ply, 0);
  assert.deepEqual(review.observations.map(item => item.selected), repeat.worlds[0]!.state.moves);
  assert.equal(observeChessLearning(repeat, review.mark, { now: now + 600000 }), undefined);
  repeat.attempts.plies += 8;
  assert.equal(observeChessLearning(repeat, review.mark, { now: now + 120001 }), undefined);
  assert.equal(observeChessLearning(repeat, review.mark, { now: now + 300001 })!.mark.issue, 'repetition');
  repeat.pendingInputs[repeat.mainId] = { before: repeat.worlds[0]!.state, san: 'Nf3' };
  assert.equal(observeChessLearning(repeat, undefined, { now }), undefined);
});

test('failure reviews distinguish loss and draw, preserve goals, and refuse inconsistent engine facts', async () => {
  const base = await fixture(), now = 1000000;
  const loss = await played(base, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.equal(observeChessLearning(loss, undefined, { now })!.mark.issue, 'lost-game');
  assert.equal(observeChessLearning(loss, undefined, { now, player: 'b', bootstrap: true }), undefined);
  const draw = await played(base, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
  const review = observeChessLearning(draw, undefined, { now })!;
  assert.equal(review.mark.issue, 'draw'); assert.equal(review.observations.length, 8);
  draw.objective = 'preserve my queen';
  assert.equal(observeChessLearning(draw, review.mark, { now: now + 120001, goalSettled: false }), undefined);
  assert.equal(observeChessLearning(draw, review.mark, { now: now + 120001, goalSettled: true })!.mark.objective, 'preserve my queen');
  draw.worlds[0]!.state.fen = loss.worlds[0]!.state.fen;
  assert.throws(() => observeChessLearning(draw, undefined, { now }), /saved move history/);
});


test('expired temporary goals trigger a bounded review with the actual outcome and no repeated idle calls', async () => {
  const { chessGoalFrame, proposeChessTemporaryGoal, advanceChessTemporaryGoal } = await import('./temporary-goal.ts');
  const base = await fixture(), snapshot = await played(base, ['e4', 'e5', 'Nf3', 'Nc6']);
  const start = base.worlds[0]!.state, world = snapshot.worlds[0]!;
  const frame = chessGoalFrame({ scopeId: 'test', state: start, player: 'w', objective: snapshot.objective, source: { id: 'strategy', version: '1' } });
  const goal = proposeChessTemporaryGoal({ key: 'mate', instruction: 'Seek checkmate', reason: 'Test bounded pursuit', evidence: ['current-state'], duration: 4, target: { kind: 'checkmate' } }, { frame, player: 'w' }, start)!;
  world.temporaryGoal = advanceChessTemporaryGoal(goal, { ...frame, clock: { unit: 'chess-plies', value: 4 } }, world.state, 'w');
  const review = observeChessLearning(snapshot, undefined, { now: 1000000 })!;
  assert.equal(review.mark.issue, 'goal-failed'); assert.equal(review.temporaryGoal!.record.status, 'expired');
  assert.equal(review.temporaryGoal!.record.id, goal.record.id);
  assert.equal(observeChessLearning(snapshot, review.mark, { now: 2000000 }), undefined);
  snapshot.attempts.plies++;
  assert.equal(observeChessLearning(snapshot, review.mark, { now: 2000000 }), undefined);
});
