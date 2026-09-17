import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../../packages/game-bridge/src/engine.ts';
import { DoomMap, geometryFor } from '../../apps/server/src/doom-geometry.ts';
import { doomInputs } from '../../apps/server/src/doom-controls.ts';
import { navigateDoomInputs, type NavigationMemory } from '../../apps/server/src/doom-navigation.ts';
import type { Input } from '../../packages/contracts/src/game.ts';

// Drive the real engine into barriers with normal inputs, then compare the old
// motor control with local recovery at identical starts. No player-state edits.
const reports = [];
for (const turn of [0, 7, 14, 21, 28, 35, 42, 49]) {
  for (const direction of ['forward', 'backward', 'strafeLeft', 'strafeRight'] as Input[]) {
    const pair = [];
    for (const mode of ['old', 'recovery', 'unmapped-obstruction']) {
      const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
      for (let tick = 0; tick < turn; tick++) game.step({ ticks: 1, inputs: ['left'] });
      let stopped = 0;
      for (let tick = 0; tick < 350 && stopped < 10; tick++) {
        const before = game.state(), after = game.step({ ticks: 1, inputs: [direction] });
        stopped = Math.hypot(after.x - before.x, after.y - before.y) < .5 ? stopped + 1 : 0;
      }
      assert.equal(stopped, 10, 'setup must reach a real collision');
      const initial = game.state(), memory: NavigationMemory = {}, map = mode === 'unmapped-obstruction' ? new DoomMap([]) : await geometryFor(initial, true, true);
      let escapeTick: number | undefined;
      for (let tick = 0; tick < 105; tick++) {
        const state = game.state();
        const inputs = mode === 'old' ? doomInputs(state, [direction], map) : navigateDoomInputs(state, [direction], map, memory);
        const after = game.step({ ticks: 1, inputs });
        if (Math.hypot(after.x - initial.x, after.y - initial.y) >= 64) { escapeTick = tick + 1; break; }
      }
      pair.push({ mode, initial: { x: initial.x, y: initial.y, z: initial.z, angle: initial.angle, tick: initial.tick }, escapeTick: escapeTick ?? null });
    }
    assert.deepEqual(pair[0]!.initial, pair[1]!.initial);
    assert.deepEqual(pair[0]!.initial, pair[2]!.initial);
    reports.push({ turn, direction, pair });
  }
}
await mkdir('artifacts/obstacle-recovery', { recursive: true });
await writeFile('artifacts/obstacle-recovery/engine.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify({ cases: reports.length, oldEscaped: reports.filter(r => r.pair[0]!.escapeTick !== null).length, recovered: reports.filter(r => r.pair[1]!.escapeTick !== null).length, maxEscapeTicks: Math.max(...reports.map(r => r.pair[1]!.escapeTick ?? 999)), unmappedRecovered: reports.filter(r => r.pair[2]!.escapeTick !== null).length, unmappedMaxTicks: Math.max(...reports.map(r => r.pair[2]!.escapeTick ?? 999)), failures: reports.filter(r => r.pair[1]!.escapeTick === null || r.pair[2]!.escapeTick === null) }));
assert.ok(reports.every(r => r.pair[1]!.escapeTick !== null && r.pair[2]!.escapeTick !== null), 'all obstacle fixtures must recover within three game seconds');
