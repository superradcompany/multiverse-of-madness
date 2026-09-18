import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import type { Step } from '../../examples/doom/contracts/src/game.ts';
import { Jev } from '../../examples/doom/server/src/jev.ts';
import { Session } from '../../examples/doom/server/src/session.ts';
import type { WorldRuntime } from '../../examples/doom/server/src/runtime.ts';
import { navigateDoomInputs } from '../../examples/doom/server/src/doom-navigation.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';

// Real Doom execution with deterministic input replay for experiment clones.
// This evaluates the policy only. It is NOT a VM-fork/performance benchmark.
class ReplayWorld implements WorldRuntime {
  identity: string;
  destroyed = false;
  constructor(readonly id: string, private engine: DoomEngine, private trace: Step[] = []) { this.identity = `evaluation:${id}`; }
  async state() { return this.engine.state(); }
  async frame() { return Buffer.alloc(0); }
  async step(step: Step) { assert.ok(!this.destroyed); this.trace.push(structuredClone(step)); return this.engine.step(step); }
  async destroy() { this.destroyed = true; }
  async branch(ids: string[]) {
    const worlds: ReplayWorld[] = [];
    for (const id of ids) {
      const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
      for (const step of this.trace) engine.step(step);
      assert.deepEqual(engine.state(), this.engine.state());
      worlds.push(new ReplayWorld(id, engine, structuredClone(this.trace)));
    }
    return worlds;
  }
}
await mkdir('artifacts/calibration/policy-plans', { recursive: true });
// Diagnostic follow-up on the two starts where standalone game-aware play died.
// No threshold/prompt tuning uses these results.
for (const scenario of [0, 4]) {
  const { setup } = JSON.parse(await readFile(`artifacts/calibration/validated/play-game-aware-heldout-${scenario}.json`, 'utf8')) as { setup: Step[] };
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const source = new ReplayWorld(`policy-${scenario}`, engine);
  for (const step of setup) await source.step(step);
  const initial = await source.state(), deadline = initial.tick + 60 * 35;
  const session = new Session(new Jev(), { threshold: .75, horizon: 210, branches: 4, paceMs: 0, frameTicks: 1 });
  session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
  await session.initialize(source);
  let stopping = false;
  session.on('change', () => {
    const view = session.snapshot(), main = view.worlds.find(w => w.id === view.mainId)!;
    if (!stopping && (main.state.tick >= deadline || main.state.phase !== 'level')) { stopping = true; void session.pause(); }
  });
  try {
    session.resume(); await session.idle();
    const view = session.snapshot(), main = view.worlds.find(w => w.id === view.mainId)!;
    const result = { diagnostic: true, scenario, setup, initial, final: main.state, gameSeconds: (main.state.tick - initial.tick) / 35, threshold: .75, trialSeconds: 6, routing: view.routing, error: view.error, alive: main.state.alive, exited: main.state.phase === 'intermission' || main.state.map !== initial.map };
    await writeFile(`artifacts/calibration/policy-plans/scenario-${scenario}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, initial: undefined, final: { health: main.state.health, kills: main.state.kills } }));
  } finally { await session.close(); }
}
