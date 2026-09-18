import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { doomInputs } from '../../examples/doom/server/src/doom-controls.ts';
import { actions, type Decision } from '../../examples/doom/server/src/jev.ts';
import type { GameState, Step } from '../../examples/doom/contracts/src/game.ts';

const root = process.argv[2] ?? 'artifacts/calibration/validated';
for (const name of (await readdir(root)).filter(n => /^play-.*\.json$/.test(n))) {
  const row = JSON.parse(await readFile(`${root}/${name}`, 'utf8')) as { profile: string; setup: Step[]; initial: GameState; final: GameState; decisions: Array<{ before: GameState; decision: Decision; after: GameState }>; audit?: unknown };
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  for (const step of row.setup) engine.step(step);
  assert.deepEqual(engine.state(), row.initial);
  let ammoSpent = 0, unalignedAmmoSpent = 0, wallBlockedAmmoSpent = 0, healthLost = 0;
  for (const round of row.decisions) {
    assert.deepEqual(engine.state(), round.before);
    const map = await geometryFor(round.before, row.profile === 'calibrated-v2' || row.profile === 'calibrated-v3' || row.profile === 'game-aware', row.profile === 'calibrated-v3' || row.profile === 'game-aware');
    for (let tick = 0; tick < round.after.tick - round.before.tick; tick++) {
      const before = engine.state(), requested = [...actions[round.decision.action].inputs];
      const inputs = ['assisted', 'feedback', 'calibrated', 'calibrated-v2', 'calibrated-v3', 'calibrated-v4', 'game-aware'].includes(row.profile) ? doomInputs(before, requested, map, row.profile !== 'calibrated-v4') : requested;
      const after = engine.step({ ticks: 1, inputs });
      const spent = before.ammo.reduce((sum, n, i) => sum + Math.max(0, n - (after.ammo[i] ?? 0)), 0);
      ammoSpent += spent;
      healthLost += Math.max(0, before.health - after.health);
      const facing = before.enemies.filter(e => Math.abs(e.relativeBearing) <= 6 && Math.abs(e.position.z - before.z) <= Math.max(56, e.distance * .625));
      if (!facing.length) unalignedAmmoSpent += spent;
      else if (facing.every(e => map.sight(before, e.position) === 'solid-wall-blocked')) wallBlockedAmmoSpent += spent;
    }
    assert.deepEqual(engine.state(), round.after, 'Input replay must reproduce the evaluated state exactly');
  }
  assert.deepEqual(engine.state(), row.final);
  row.audit = { deterministicReplay: true, ammoSpent, unalignedAmmoSpent, wallBlockedAmmoSpent, healthLost,
    limits: 'Ammo counted per tick. A weapon can discharge after its trigger input was released. Aim means within 6 degrees with a plausible vertical angle; does not prove hit, visibility through moving doors, or weapon-specific aim/spread.' };
  await writeFile(`${root}/${name}`, JSON.stringify(row, null, 2));
  console.log(JSON.stringify({ name, ...row.audit as object }));
}
