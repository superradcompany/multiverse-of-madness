import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessWorld } from './runtime.ts';

test('chess forks are independent and saved history preserves threefold repetition', async () => {
  const world = new ChessWorld('root');
  for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']) await world.step({ san });
  const before = await world.state(), [draw, another] = await world.branch(['draw', 'another']);
  assert.deepEqual(await draw!.state(), before);
  assert.equal((await draw!.step({ san: 'Ng8' })).status, 'draw');
  assert.equal((await another!.step({ san: 'e5' })).status, 'ongoing');
  assert.deepEqual(await world.state(), before);
  const restored = new ChessWorld('restored', await draw!.state());
  assert.deepEqual(await restored.state(), await draw!.state());
  await assert.rejects(restored.step({ san: 'e4' }), /terminal/);
});
test('illegal candidate actions cannot alter chess state or claim a terminal outcome', async () => {
  const world = new ChessWorld('root'); const before = await world.state();
  await assert.rejects(world.step({ san: 'Qh5#' }));
  assert.deepEqual(await world.state(), before);
  await world.destroy(); await assert.rejects(world.state(), /closed/);
});
