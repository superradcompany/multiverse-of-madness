import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessWorld } from './runtime.ts';
import { chessIncidentContract } from './incident-contract.ts';
import type { ChessAutomaticMark } from './automatic-learning.ts';

test('incident evaluation pins the observed history and user goal with a separate required-improvement gate', async () => {
  const world = new ChessWorld('incident'); await world.step({ san: 'e4' }); await world.step({ san: 'e5' });
  const state = await world.state(); await world.destroy();
  const mark: ChessAutomaticMark = { origin: { activation: { epoch: 0, revision: { id: 'source', version: '1' } }, context: { id: 'goal', version: '1' } },
    evidence: { incident: state, reason: 'Repeated positions', observations: [], mark: { key: 'incident-1', objective: 'protect my queen', revision: { id: 'source', version: '1' }, issue: 'repetition', observedAt: 1, attemptedPlies: 8, selectedPlies: 2 } } };
  const contract = chessIncidentContract(mark, 2);
  assert.deepEqual(contract.scenarios[0]!.input.saved.moves, ['e4', 'e5']);
  assert.equal(contract.scenarios[0]!.input.minimumGain, .1);
  assert.ok(contract.scenarios.every(item => item.input.objective === 'protect my queen'));
  assert.deepEqual(contract.scenarios[1]!.input.saved.moves, []);
  mark.evidence.incident.moves.push('Nf3'); mark.evidence.mark.objective = 'changed';
  assert.deepEqual(contract.scenarios[0]!.input.saved.moves, ['e4', 'e5']);
  assert.equal(contract.scenarios[0]!.input.objective, 'protect my queen');
  mark.evidence.incident.status = 'draw'; assert.throws(() => chessIncidentContract(mark), /precede the terminal/);
});

test('early and repeated-opening incidents receive a different regression board without rewriting version-one evidence', async () => {
  const world = new ChessWorld('opening'), initial = await world.state();
  const mark: ChessAutomaticMark = { origin: { activation: { epoch: 0, revision: { id: 'source', version: '1' } }, context: { id: 'goal', version: '1' } },
    evidence: { incident: initial, observations: [], reason: 'Bootstrap', mark: { key: 'opening', objective: 'win', revision: { id: 'source', version: '1' }, issue: 'bootstrap', observedAt: 0, attemptedPlies: 4, selectedPlies: 4 } } };
  const old = chessIncidentContract(mark, 1), next = chessIncidentContract(mark, 2);
  assert.deepEqual(old.scenarios[1]!.input.saved.moves, []); assert.equal(old.id, 'chess-incident-opening');
  assert.deepEqual(next.scenarios[1]!.input.saved.moves, ['d4', 'd5', 'c4', 'e6']);
  assert.deepEqual(next.acceptance, old.acceptance); assert.deepEqual(next.budget, old.budget);
  const regression = new ChessWorld('regression', next.scenarios[1]!.input.saved);
  assert.notEqual((await regression.state()).fen.split(' ').slice(0, 4).join(' '), initial.fen.split(' ').slice(0, 4).join(' '));
  mark.evidence.incident = await regression.state();
  assert.deepEqual(chessIncidentContract(mark, 2).scenarios[1]!.input.saved.moves, []);
  // A repeated initial board with different move counters still needs the other case.
  for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) await world.step({ san });
  mark.evidence.incident = await world.state();
  assert.deepEqual(chessIncidentContract(mark, 2).scenarios[1]!.input.saved.moves, ['d4', 'd5', 'c4', 'e6']);
  await world.destroy(); await regression.destroy();
});

test('review input versions preserve old contracts and refuse altered cases, goals and identities', async () => {
  const { freezeChessReview, decodeFrozenChessReview } = await import('./review-input.ts');
  const world = new ChessWorld('input'), state = await world.state(); await world.destroy();
  const mark: ChessAutomaticMark = { origin: { activation: { epoch: 0, revision: { id: 'source', version: '1' } }, context: { id: 'goal', version: '1' } },
    evidence: { incident: state, observations: [], reason: 'Bootstrap', mark: { key: 'opening', objective: 'win', revision: { id: 'source', version: '1' }, issue: 'bootstrap', observedAt: 0, attemptedPlies: 4, selectedPlies: 4 } } };
  const legacy = { format: 1, id: 'old', mark, contract: chessIncidentContract(mark, 1) };
  assert.deepEqual(decodeFrozenChessReview(legacy, 'old'), legacy);
  const second = { ...legacy, format: 2, contract: chessIncidentContract(mark, 2) };
  assert.deepEqual(decodeFrozenChessReview(second, 'old'), second);
  const third = { ...legacy, format: 3, contract: chessIncidentContract(mark, 3) };
  assert.deepEqual(decodeFrozenChessReview(third, 'old'), third);
  const next = freezeChessReview('new', mark, []);
  assert.equal(next.format, 5); assert.deepEqual(decodeFrozenChessReview(next, 'new'), next);
  const { training: _training, recentTraining: _feedback, ...previousFields } = next;
  const fourth = { ...previousFields, format: 4 };
  assert.deepEqual(decodeFrozenChessReview(fourth, 'new'), fourth);
  assert.deepEqual(next.contract, fourth.contract);
  assert.equal(next.contract.budget.limits.simulation, 18);
  assert.equal(next.contract.evaluator.id, 'chess-full-harness-incident-evaluation');
  mark.evidence.mark.objective = 'changed'; assert.equal(next.mark.evidence.mark.objective, 'win');
  assert.throws(() => decodeFrozenChessReview(next, 'different'), /altered/);
  assert.throws(() => decodeFrozenChessReview({ ...next, format: 6 }, 'new'), /altered/);
  const changedPolicy = structuredClone(next); changedPolicy.policy!.breadth++;
  assert.throws(() => decodeFrozenChessReview(changedPolicy, 'new'), /altered/);
  const missingPolicy = structuredClone(next); delete missingPolicy.policy;
  assert.throws(() => decodeFrozenChessReview(missingPolicy, 'new'), /altered/);
  const changed = structuredClone(next); changed.contract.scenarios[1]!.input.saved.moves = ['e4'];
  assert.throws(() => decodeFrozenChessReview(changed, 'new'), /altered/);
  const changedGoal = structuredClone(next); changedGoal.mark.evidence.mark.objective = 'changed';
  assert.throws(() => decodeFrozenChessReview(changedGoal, 'new'), /altered/);
});
