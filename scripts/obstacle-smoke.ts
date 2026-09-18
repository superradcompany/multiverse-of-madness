import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorld, type WorldRuntime } from '../examples/doom/server/src/runtime.ts';
import { doomInputs } from '../examples/doom/server/src/doom-controls.ts';
import { navigateDoomInputs, type NavigationMemory } from '../examples/doom/server/src/doom-navigation.ts';
import { geometryFor } from '../examples/doom/server/src/doom-geometry.ts';

const source = await createWorld(`mom-obstacle-smoke-${Date.now()}`);
let children: WorldRuntime[] = [];
try {
  let stopped = 0;
  for (let tick = 0; tick < 350 && stopped < 10; tick++) {
    const before = await source.state(), after = await source.step({ ticks: 1, inputs: ['forward'] });
    stopped = Math.hypot(after.x - before.x, after.y - before.y) < .5 ? stopped + 1 : 0;
  }
  assert.equal(stopped, 10);
  const initial = await source.state(), frame = await source.frame(), map = await geometryFor(initial, true, true);
  children = await source.branch([`${source.id}-old`, `${source.id}-recovery`]);
  const result = await Promise.all(children.map(async (world, i) => {
    assert.deepEqual(await world.state(), initial);
    let state = initial, escapeTick: number | null = null;
    const memory: NavigationMemory = {};
    for (let tick = 0; tick < 105; tick++) {
      state = await world.step({ ticks: 1, inputs: i ? navigateDoomInputs(state, ['forward'], map, memory) : doomInputs(state, ['forward'], map) });
      if (Math.hypot(state.x - initial.x, state.y - initial.y) >= 64) { escapeTick = tick + 1; break; }
    }
    return { mode: i ? 'recovery' : 'old', escapeTick, final: { x: state.x, y: state.y, health: state.health } };
  }));
  assert.deepEqual(await source.state(), initial);
  assert.deepEqual(await source.frame(), frame);
  assert.ok(result[1]!.escapeTick !== null && result[1]!.escapeTick <= 70);
  await mkdir('artifacts/obstacle-recovery', { recursive: true });
  await writeFile('artifacts/obstacle-recovery/vm.json', JSON.stringify({ initial, result, sourceUnchanged: true }, null, 2));
  console.log(JSON.stringify({ realVmForks: true, sourceUnchanged: true, result }));
} finally {
  await Promise.all(children.map(w => w.destroy()));
  await source.destroy();
}
