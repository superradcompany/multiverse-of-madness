import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import { actions, type Decision } from '../../examples/doom/server/src/jev.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { doomInputs } from '../../examples/doom/server/src/doom-controls.ts';
import type { GameState, Step } from '../../examples/doom/contracts/src/game.ts';

// Diagnostic read of the pinned engine's independent event and object exports.
// No player/map state is edited. Event clearing only drains the host event buffer.
type Exports = { memory: WebAssembly.Memory; wasmdoom_events_ptr(): number; wasmdoom_events_len(): number; wasmdoom_events_clear(): void; wasmdoom_snapshot_map_objects(): number; wasmdoom_map_objects_ptr(): number };
const root = 'artifacts/calibration/validated';
const reports = [];
for (const name of (await readdir(root)).filter(n => /^play-(baseline|game-aware)-.*\.json$/.test(n))) {
  const row = JSON.parse(await readFile(`${root}/${name}`, 'utf8')) as { profile: string; setup: Step[]; initial: GameState; final: GameState; decisions: Array<{ before: GameState; after: GameState; decision: Decision }> };
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  const wasm = (game as unknown as { wasm: Exports }).wasm;
  for (const step of row.setup) game.step(step);
  assert.deepEqual(game.state(), row.initial);
  const countable = new Set<number>();
  const count = wasm.wasmdoom_snapshot_map_objects();
  const objects = new DataView(wasm.memory.buffer, wasm.wasmdoom_map_objects_ptr(), count * 32);
  for (let at = 0; at < objects.byteLength; at += 32) if (objects.getUint32(at + 24, true) & 0x400000) countable.add(objects.getInt32(at + 16, true));
  const deaths: Array<{ tick: number; type: number; byPlayer: boolean; counted: boolean }> = [];
  let counterIncreases = 0;
  for (const round of row.decisions) {
    assert.deepEqual(game.state(), round.before);
    const map = row.profile === 'game-aware' ? await geometryFor(round.before, true, true) : undefined;
    for (let tick = round.before.tick; tick < round.after.tick; tick++) {
      const before = game.state();
      const requested = [...actions[round.decision.action].inputs];
      wasm.wasmdoom_events_clear();
      const after = game.step({ ticks: 1, inputs: map ? doomInputs(before, requested, map) : requested });
      const buffer = new DataView(wasm.memory.buffer, wasm.wasmdoom_events_ptr(), wasm.wasmdoom_events_len());
      let expected = 0;
      for (let at = 0; at < buffer.byteLength;) {
        const tag = buffer.getUint16(at, true), length = buffer.getUint16(at + 2, true);
        assert.ok(at + 4 + length <= buffer.byteLength);
        if (tag === 130) {
          assert.equal(length, 16);
          const type = buffer.getUint32(at + 4, true), counted = countable.has(type);
          deaths.push({ tick: after.tick, type, byPlayer: Boolean(buffer.getUint32(at + 16, true)), counted });
          expected += Number(counted);
        }
        at += length + 4;
      }
      if (before.map === after.map && before.episode === after.episode) {
        assert.equal(after.kills - before.kills, expected, `${name}, tick ${after.tick}: engine death events versus kill counter`);
        counterIncreases += after.kills - before.kills;
      }
    }
    assert.deepEqual(game.state(), round.after);
  }
  assert.deepEqual(game.state(), row.final);
  reports.push({ name, counterIncreases, deaths });
}
await mkdir('artifacts/kill-audit', { recursive: true });
await writeFile('artifacts/kill-audit/engine-events.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify({ runs: reports.length, counterIncreases: reports.reduce((n, r) => n + r.counterIncreases, 0), deathEvents: reports.flatMap(r => r.deaths).length, byPlayer: reports.flatMap(r => r.deaths).filter(d => d.counted && d.byPlayer).length, otherCountedDeaths: reports.flatMap(r => r.deaths).filter(d => d.counted && !d.byPlayer).length, matchedEveryTick: true }));
