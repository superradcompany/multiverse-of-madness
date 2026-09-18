import type { GameState } from '../../contracts/src/game.ts';

export interface TimelineStats {
  kills: number; items: number; secrets: number; levels: number; ticks: number;
  damage: number; healing: number; ammoSpent: number; visited: string[];
  lastProgressTick: number; lastKillTick?: number; partial: boolean;
}
export const cell = (s: GameState) => `${s.episode}:${s.map}:${Math.floor(s.x / 128)}:${Math.floor(s.y / 128)}:${Math.floor(s.z / 32)}`;
export function initialStats(s: GameState, partial = false): TimelineStats {
  return { kills: s.kills, items: s.items, secrets: s.secrets, levels: 0, ticks: 0,
    damage: 0, healing: 0, ammoSpent: 0, visited: [cell(s)], lastProgressTick: s.tick, lastKillTick: s.tick, partial };
}
export function counterIncrease(before: GameState, after: GameState, key: 'kills' | 'items' | 'secrets'): number {
  const sameMap = before.map === after.map && before.episode === after.episode;
  return Math.max(0, after[key] - (sameMap ? before[key] : 0));
}
export function advanceStats(stats: TimelineStats, before: GameState, after: GameState) {
  const sameMap = before.map === after.map && before.episode === after.episode;
  const delta = (key: 'kills' | 'items' | 'secrets') => counterIncrease(before, after, key);
  stats.lastKillTick ??= before.tick;
  if (delta('kills')) stats.lastKillTick = after.tick;
  const exited = before.phase === 'level' && (after.phase === 'intermission' || after.phase === 'finale')
    || !sameMap && before.phase === 'level';
  const novel = after.phase === 'level' && !stats.visited.includes(cell(after));
  if (exited || novel || delta('kills') || delta('items') || delta('secrets') || after.health > before.health) stats.lastProgressTick = after.tick;
  stats.kills += delta('kills'); stats.items += delta('items'); stats.secrets += delta('secrets');
  stats.levels += Number(exited); stats.ticks += Math.max(0, after.tick - before.tick);
  if (sameMap) {
    stats.damage += Math.max(0, before.health - after.health);
    stats.healing += Math.max(0, after.health - before.health);
    stats.ammoSpent += before.ammo.reduce((sum, ammo, i) => sum + Math.max(0, ammo - (after.ammo[i] ?? 0)), 0);
  }
  if (novel) stats.visited.push(cell(after));
}
