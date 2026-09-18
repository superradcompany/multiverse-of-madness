import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceMemory, type EvidencePolicy } from '../src/experience.ts';

type Turn = { round: number; board: string; points: number };
type Attempt = { action: string; board: string; gained: number };
const policy: EvidencePolicy<Turn, Attempt> = {
  capture: (_id, action, before, after) => after.round > before.round ? { action, board: before.board, gained: after.points-before.points } : undefined,
  distance: (state, record) => state.board === record.board ? 0 : undefined,
  group: record => record.action,
  adverse: record => record.gained < 0,
};
test('memory retains counterevidence with game-owned matching and bounded independent copies', () => {
  const memory = new EvidenceMemory(policy, 3);
  const before = { round: 1, board: 'abc', points: 4 };
  memory.remember('a', 'swap', before, { ...before, round: 2, points: 6 });
  memory.remember('b', 'swap', before, { ...before, round: 2, points: 2 });
  memory.remember('c', 'pass', before, { ...before, round: 2, points: 4 });
  memory.remember('d', 'swap', before, { ...before, round: 2, points: 7 });
  assert.equal(memory.records.length, 3);
  const result = memory.relevant(before, 2);
  assert.deepEqual(result.map(r => r.gained), [3, -2]);
  result[0]!.board = 'changed';
  assert.equal(memory.records.at(-1)!.board, 'abc');
  assert.deepEqual(memory.relevant({ ...before, board: 'other' }), []);
  assert.throws(() => memory.setCapacity(0));
});
