import type { GameState, Input } from '../../../packages/contracts/src/game.ts';
import { doomInputs } from './doom-controls.ts';
import type { PlanExecution } from './doom-plans.ts';
import type { DoomMap } from './doom-geometry.ts';

// Per-world, serializable motor memory. Forks copy it; sibling futures never
// share it. This is local collision recovery, not a route planner or Jev output.
export interface NavigationMemory {
  previous?: { tick: number; episode: number; map: number; x: number; y: number; translating: boolean; heading?: number };
  blocked?: Array<{ heading: number; x: number; y: number; tick: number }>;
  stalled?: number;
  escape?: { heading: number; turn: 'left' | 'right'; x: number; y: number; tick: number };
}
/** Collision recovery belongs to one movement step, never a later aim/use step. */
export function planNavigationMemory(memory: NavigationMemory | undefined, run: PlanExecution, previousStep: number): NavigationMemory | undefined {
  const kind = run.plan.steps[run.step]?.kind;
  return run.status === 'running' && run.step === previousStep && (kind === 'move' || kind === 'strafeAttack') ? memory : undefined;
}
const difference = (a: number, b: number) => ((a - b + 540) % 360 + 360) % 360 - 180;
const movement = (inputs: Input[]) => inputs.some(i => ['forward', 'backward', 'strafeLeft', 'strafeRight'].includes(i));

export function navigateDoomInputs(state: GameState, requested: Input[], map: DoomMap, memory: NavigationMemory): Input[] {
  const previous = memory.previous;
  if (!previous || previous.episode !== state.episode || previous.map !== state.map || state.tick !== previous.tick + 1) {
    memory.stalled = 0;
    memory.blocked = [];
    // Pausing does not advance game time; repeated reads are harmless. A time
    // discontinuity (manual play, reconnect gap, map change) invalidates the turn.
    if (previous && (state.tick !== previous.tick || previous.episode !== state.episode || previous.map !== state.map)) memory.escape = undefined;
  } else {
    memory.stalled = previous.translating && Math.hypot(state.x - previous.x, state.y - previous.y) < .5 ? (memory.stalled ?? 0) + 1 : 0;
  }
  const finish = (inputs: Input[]) => {
    memory.previous = { tick: state.tick, episode: state.episode, map: state.map, x: state.x, y: state.y, translating: movement(inputs), heading: state.angle + (inputs.includes('forward') ? 0 : inputs.includes('backward') ? 180 : inputs.includes('strafeLeft') ? 90 : -90) };
    return inputs;
  };
  if (!state.alive || state.phase !== 'level' || !movement(requested)) {
    memory.escape = undefined;
    return finish(doomInputs(state, requested, map));
  }
  const offset = requested.includes('forward') ? 0 : requested.includes('backward') ? 180 : requested.includes('strafeLeft') ? 90 : -90;
  const clearance = map.clearance(state, state.angle + offset);
  const lookahead = Math.max(20, Math.hypot(state.velocity.x, state.velocity.y) * 4);
  let escape = memory.escape;
  const escapeClear = map.clearance(state, state.angle);
  if (escape && Math.hypot(state.x - escape.x, state.y - escape.y) >= 64 && escapeClear > lookahead) {
    memory.escape = escape = undefined;
  }
  // Give a door/use attempt a short opportunity, then recover from observed
  // failure even when static geometry cannot see the moving obstruction.
  const stalled = (memory.stalled ?? 0) >= 7;
  memory.blocked = (memory.blocked ?? []).filter(b => state.tick - b.tick < 140 && Math.hypot(state.x - b.x, state.y - b.y) < 64);
  if (stalled) memory.blocked.push({ heading: previous?.heading ?? state.angle + offset, x: state.x, y: state.y, tick: state.tick });
  if ((!escape && (clearance <= lookahead || stalled))
      || (escape && (stalled || state.tick - escape.tick >= 70))) {
    let directions = Array.from({ length: 24 }, (_, i) => {
      const delta = (i < 12 ? 1 : -1) * ((i % 12 + 1) * 15);
      const heading = state.angle + delta;
      return { heading, delta, clearance: map.clearance(state, heading, 192) };
    });
    const untried = directions.filter(d => !memory.blocked!.some(b => Math.abs(difference(d.heading, b.heading)) < 60));
    if (untried.length) directions = untried;
    // Smallest viable turn first, with clearance breaking left/right ties.
    // If boxed in, face the most open direction instead of driving at the wall.
    directions.sort((a, b) => Number(b.clearance >= 96) - Number(a.clearance >= 96)
      || (a.clearance >= 96 && b.clearance >= 96 ? Math.abs(a.delta) - Math.abs(b.delta) || b.clearance - a.clearance : b.clearance - a.clearance));
    const best = directions[0]!;
    memory.escape = escape = { heading: best.heading, turn: best.delta > 0 ? 'left' : 'right', x: state.x, y: state.y, tick: state.tick };
    memory.stalled = 0;
  }
  if (escape) {
    const angle = difference(escape.heading, state.angle);
    // Commit to the heading until aligned; aim assistance must not cancel a
    // collision-recovery turn when an enemy happens to cross the crosshair.
    if (Math.abs(angle) > 7) return finish([Math.abs(angle) > 170 ? escape.turn : angle > 0 ? 'left' : 'right']);
    const inputs: Input[] = ['forward'];
    // Pulse use so a held command can retry a door after arriving in range.
    if (state.tick % 7 === 0) inputs.push('use');
    return finish(doomInputs(state, inputs, map));
  }
  const inputs = doomInputs(state, requested, map);
  return finish(inputs.filter(i => i !== 'use' || state.tick % 7 === 0));
}
