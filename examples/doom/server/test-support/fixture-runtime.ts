import { actions, type Decision } from '../src/jev.ts';
import type { WorldRuntime } from '../src/runtime.ts';
import type { GameState, Step } from '../../contracts/src/game.ts';

export const initial: GameState = { tick: 35, health: 100, armor: 0, ammo: [50, 0, 0, 0], kills: 0, items: 0, secrets: 0, x: 0, y: 0, z: 0, angle: 0, episode: 1, map: 1, phase: 'level', alive: true, velocity: { x: 0, y: 0, z: 0 }, enemies: [], projectiles: [], pickups: [], telemetry: { radius: 2048, lineOfSightKnown: false, engineObjectCount: 1 } };
export const decision: Decision = { action: 'advance', confidence: 0.3, probabilities: Object.fromEntries(Object.keys(actions).map(key => [key, 1 / 8])) as Decision['probabilities'], priority: 'exploration', latencyMs: 0, model: 'test' };
export class Runtime implements WorldRuntime {
  readonly identity: string;
  destroyed = false;
  constructor(readonly id: string, private game = structuredClone(initial)) { this.identity = `physical-${id}`; }
  async state() { return structuredClone(this.game); }
  async frame() { return Buffer.from(JSON.stringify(this.game)); }
  async step(command: Step) { this.game.tick += command.ticks; return this.state(); }
  async branch(ids: string[]) { return ids.map(id => new Runtime(id, structuredClone(this.game))); }
  async destroy() { this.destroyed = true; }
}
