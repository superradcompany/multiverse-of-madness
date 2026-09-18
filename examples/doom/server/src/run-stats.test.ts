import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceStats, initialStats } from './run-stats.ts';
import type { GameState } from '../../contracts/src/game.ts';
const start = { tick: 35, health: 100, armor: 0, ammo: [50, 0, 0, 0], kills: 2, items: 1, secrets: 0, x: 0, y: 0, z: 0, episode: 1, map: 1, phase: 'level', alive: true } as GameState;
test('run counters survive map resets and count exits once', () => {
  const s = initialStats(start), fight = { ...start, tick: 70, kills: 5, health: 80, ammo: [45, 0, 0, 0], x: 256 };
  advanceStats(s, start, fight);
  const exit = { ...fight, tick: 71, phase: 'intermission' as const }; advanceStats(s, fight, exit);
  const next = { ...start, tick: 72, map: 2, kills: 0, items: 0 }; advanceStats(s, exit, next);
  advanceStats(s, next, { ...next, tick: 73, kills: 1 });
  assert.equal(s.kills, 6); assert.equal(s.items, 1); assert.equal(s.levels, 1);
  assert.equal(s.damage, 20); assert.equal(s.ammoSpent, 5); assert.equal(s.ticks, 38);
});
test('revisiting old cells does not count as new progress', () => {
  const s = initialStats(start), moved = { ...start, tick: 70, x: 256 };
  advanceStats(s, start, moved); advanceStats(s, moved, { ...start, tick: 105 });
  assert.equal(s.visited.length, 2); assert.equal(s.lastProgressTick, 70);
});
