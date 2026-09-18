import { EvidenceMemory } from '@multiverse/gameplay-harness';
import { counterIncrease } from './run-stats.ts';
import type { GameState } from '../../contracts/src/game.ts';

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

// Game-specific evidence features and matching remain in the Doom adapter.
// Storage bounds, recency, diversity and counterevidence are shared harness code.
export class ExperienceMemory extends EvidenceMemory<GameState, Experience> {
  constructor(capacity = 128) {
    super({
      capture: (worldId, action, before, after) => after.tick <= before.tick ? undefined : ({
        worldId, action, start: context(before), result: {
          ticks: after.tick - before.tick, health: after.health - before.health,
          kills: counterIncrease(before, after, 'kills'), ammo: after.ammo.reduce((a,b) => a+b,0) - before.ammo.reduce((a,b) => a+b,0),
          moved: Math.round(Math.hypot(after.x-before.x,after.y-before.y)), died: !after.alive,
          exited: after.map !== before.map || after.episode !== before.episode || after.phase === 'intermission',
        },
      }),
      distance: (state, record) => {
        const current=context(state), start=record.start;
        const distance=Math.hypot(start.x-current.x,start.y-current.y);
        return start.episode === current.episode && start.map === current.map
          && distance <= 192 && Math.abs(start.z-current.z) <= 32 && angleDifference(start.angle,current.angle) <= 45
          && Math.abs(start.health-current.health) <= 25 && start.ammo === current.ammo
          && start.enemy?.type === current.enemy?.type
          && (!start.enemy || !current.enemy || Math.abs(start.enemy.distance-current.enemy.distance) <= 128
            && angleDifference(start.enemy.bearing,current.enemy.bearing) <= 45) ? distance : undefined;
      },
      group: record => record.action,
      adverse: record => record.result.died || record.result.health < 0,
    }, capacity, { minimumCapacity:8, maximumCapacity:1024, maximumResults:8 });
  }
}
