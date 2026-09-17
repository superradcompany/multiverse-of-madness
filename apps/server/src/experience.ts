import { counterIncrease } from './run-stats.ts';
import type { GameState } from '../../../packages/contracts/src/game.ts';

export interface Experience {
  worldId: string;
  action: string;
  start: { episode: number; map: number; x: number; y: number; z: number; angle: number; health: number; ammo: boolean;
    enemy?: { type: number; distance: number; bearing: number } };
  result: { ticks: number; health: number; kills: number; ammo: number; moved: number; died: boolean; exited: boolean };
}
const angleDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
function context(state: GameState): Experience['start'] {
  const enemy = state.enemies[0];
  return { episode: state.episode, map: state.map, x: state.x, y: state.y, z: state.z, angle: state.angle,
    health: state.health, ammo: state.ammo.some(n => n > 0),
    enemy: enemy ? { type: enemy.engineType, distance: enemy.distance, bearing: enemy.relativeBearing } : undefined };
}

export class ExperienceMemory {
  records: Experience[] = [];
  constructor(public capacity = 128) {}
  setCapacity(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 8 || capacity > 1024) throw new Error('Memory capacity must be 8–1024 attempts');
    this.capacity = capacity; this.records = this.records.slice(-capacity);
  }
  remember(worldId: string, action: string, before: GameState, after: GameState) {
    if (after.tick <= before.tick) return;
    this.records.push({ worldId, action, start: context(before), result: {
      ticks: after.tick - before.tick, health: after.health - before.health,
      kills: counterIncrease(before, after, 'kills'), ammo: after.ammo.reduce((a, b) => a + b, 0) - before.ammo.reduce((a, b) => a + b, 0),
      moved: Math.round(Math.hypot(after.x - before.x, after.y - before.y)), died: !after.alive,
      exited: after.map !== before.map || after.episode !== before.episode || after.phase === 'intermission',
    } });
    this.records = this.records.slice(-this.capacity);
  }
  relevant(state: GameState, limit = 3): Experience[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Decision memory limit must be 1–8 attempts');
    const current = context(state);
    const matching = this.records.map((record, index) => ({ record, index, distance: Math.hypot(record.start.x - current.x, record.start.y - current.y) }))
      .filter(({ record: { start }, distance }) => start.episode === current.episode && start.map === current.map
        && distance <= 192 && Math.abs(start.z - current.z) <= 32 && angleDifference(start.angle, current.angle) <= 45
        && Math.abs(start.health - current.health) <= 25 && start.ammo === current.ammo
        && (start.enemy?.type === current.enemy?.type)
        && (!start.enemy || !current.enemy || Math.abs(start.enemy.distance - current.enemy.distance) <= 128
          && angleDifference(start.enemy.bearing, current.enemy.bearing) <= 45))
      .sort((a, b) => a.distance - b.distance || b.index - a.index);
    const selected: Experience[] = [];
    const first = matching[0]?.record;
    if (first) {
      selected.push(first);
      const adverse = (r: Experience) => r.result.died || r.result.health < 0;
      const counter = matching.find(({ record }) => record.action === first.action && adverse(record) !== adverse(first))?.record;
      if (counter && limit > 1) selected.push(counter);
    }
    for (const { record } of matching) {
      if (selected.length >= limit) break;
      if (selected.includes(record)) continue;
      if (selected.filter(r => r.action === record.action).length >= 2) continue;
      selected.push(record);

    }
    for (const { record } of matching) { if (selected.length >= limit) break; if (!selected.includes(record)) selected.push(record); }
    return structuredClone(selected);
  }
}
