import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { candidatePlans, planInputs, startPlan } from '../../examples/doom/server/src/doom-plans.ts';
import { doomInputs } from '../../examples/doom/server/src/doom-controls.ts';
import { defaultDoomMotorPolicy } from '../../examples/doom/server/src/doom-motor-policy.ts';
import type { GameState } from '../../examples/doom/contracts/src/game.ts';

// Offline, deterministic WASM inputs. No VM, model, saved demo or player-state
// mutation. This measures controller behavior in one encounter, not Doom skill.
const results = [];
for (const aimToleranceDegrees of [6, 3]) {
  const motor = { ...defaultDoomMotorPolicy, aimToleranceDegrees };
  for (const turns of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
    for (let i = 0; i < 86; i++) engine.step({ ticks: 1, inputs: ['forward'] });
    for (let i = 0; i < turns; i++) engine.step({ ticks: 1, inputs: ['left'] });
    const before = engine.state(), map = await geometryFor(before, true, true);
    const plan = candidatePlans(before, map).find(plan => plan.id === 'engage');
    if (!plan) throw new Error(`No engage candidate for heading case ${turns}`);
    const run = startPlan(plan, before, 210), history: GameState[] = [];
    let current = before, suppressedFireTicks = 0;
    for (let i = 0; i < 210 && run.status === 'running'; i++) {
      const intent = planInputs(run, current, history, map, undefined, motor);
      if (run.status !== 'running') break;
      const inputs = intent.every(input => input === 'left' || input === 'right')
        ? intent : doomInputs(current, intent, map, true, motor);
      if (intent.includes('fire') && !inputs.length) suppressedFireTicks++;
      history.push(current); if (history.length > 10) history.shift();
      current = engine.step({ ticks: 1, inputs });
    }
    results.push({ aimToleranceDegrees, turns, suppressedFireTicks, kills: current.kills - before.kills,
      healthChange: current.health - before.health, ticks: current.tick - before.tick, status: run.status, reason: run.reason });
  }
}
console.log(JSON.stringify({ kind: 'local-wasm-controller-check', results }, null, 2));
