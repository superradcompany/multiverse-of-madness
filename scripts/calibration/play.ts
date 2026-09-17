import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../../packages/game-bridge/src/engine.ts';
import { actions, Jev, type Decision } from '../../apps/server/src/jev.ts';
import { LabJev, type LabProfile } from './lab-jev.ts';
import { navigateDoomInputs, type NavigationMemory } from '../../apps/server/src/doom-navigation.ts';
import { doomInputs } from '../../apps/server/src/doom-controls.ts';
import { geometryFor } from '../../apps/server/src/doom-geometry.ts';
import type { GameState, Step } from '../../packages/contracts/src/game.ts';

const profile = process.argv[2] as LabProfile | 'game-aware';
assert.ok(['baseline', 'grounded', 'spatial', 'tactical', 'assisted', 'feedback', 'calibrated', 'calibrated-v2', 'calibrated-v3', 'calibrated-v4', 'game-aware'].includes(profile));
const split = process.argv[3] ?? 'development';
const cases: Step[][] = split === 'development' ? [[], [{ ticks: 35, inputs: ['forward'] }]] : [[{ ticks: 14, inputs: ['left'] }, { ticks: 35, inputs: ['forward'] }], [{ ticks: 14, inputs: ['right'] }, { ticks: 35, inputs: [] }], [{ ticks: 28, inputs: ['left'] }, { ticks: 35, inputs: ['forward'] }], [{ ticks: 28, inputs: ['right'] }, { ticks: 35, inputs: ['forward'] }], Array.from({ length: 3 }, () => ({ ticks: 35, inputs: [] })), [{ ticks: 35, inputs: ['forward'] }, { ticks: 35, inputs: ['forward'] }, { ticks: 7, inputs: ['left'] }]];
const rounds = 60, objective = 'survive and reach the exit';
const root = profile === 'game-aware' ? 'artifacts/calibration/validated-navigation' : 'artifacts/calibration/validated';
await mkdir(root, { recursive: true });
for (let scenario = 0; scenario < cases.length; scenario++) {
  const file = `${root}/play-${profile}-${split}-${scenario}.json`;
  try { await readFile(file); console.log(`Already exists: ${file}`); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
  for (const step of cases[scenario]!) engine.step(step);
  const initial = engine.state(), history: GameState[] = [initial], navigation: NavigationMemory = {};
  const decider = profile === 'game-aware' ? new Jev() : new LabJev(profile), decisions = [], cells = new Set<string>();
  let damage = 0, kills = 0, ammoSpent = 0, blockedShots = 0, noTargetShots = 0, stalled = 0;
  for (let round = 0; round < rounds; round++) {
    const before = engine.state();
    if (!before.alive || before.phase !== 'level' || before.map !== initial.map) break;
    const geometry = await geometryFor(before, profile === 'calibrated-v2' || profile === 'calibrated-v3' || profile === 'game-aware', profile === 'calibrated-v3' || profile === 'game-aware');
    const decision: Decision = await decider.decide(before, objective, history.slice(-10), AbortSignal.timeout(15_000), [], 35, { previousAction: decisions.length ? actions[decisions.at(-1)!.decision.action].label : undefined });
    const inputs = [...actions[decision.action].inputs];
    // Match live bridge's per-tick input release/repress and history granularity.
    let after = before;
    for (let tick = 0; tick < 35; tick++) {
      after = engine.step({ ticks: 1, inputs: profile === 'game-aware' ? navigateDoomInputs(after, inputs, geometry, navigation) : ['assisted', 'feedback', 'calibrated', 'calibrated-v2', 'calibrated-v3', 'calibrated-v4'].includes(profile) ? doomInputs(after, inputs, geometry, profile !== 'calibrated-v4') : inputs }); history.push(after);
      cells.add(`${Math.floor(after.x / 128)},${Math.floor(after.y / 128)},${Math.floor(after.z / 32)}`);
      if (!after.alive || after.phase !== 'level' || after.map !== initial.map) break;
    }
    const bullets = Math.max(0, before.ammo.reduce((a, b) => a + b, 0) - after.ammo.reduce((a, b) => a + b, 0));
    const facing = before.enemies.filter(e => Math.abs(e.relativeBearing) <= 10);
    const allBlocked = facing.length > 0 && facing.every(e => geometry.sight(before, e.position) === 'solid-wall-blocked');
    if (allBlocked && inputs.includes('fire')) blockedShots += bullets;
    if (!facing.length && inputs.includes('fire')) noTargetShots += bullets;
    damage += Math.max(0, before.health - after.health); kills += after.kills - before.kills; ammoSpent += bullets;
    if (inputs.some(i => ['forward', 'backward', 'strafeLeft', 'strafeRight'].includes(i)) && Math.hypot(after.x - before.x, after.y - before.y) < 8) stalled++;
    decisions.push({ before, decision, after, blockedAtDecision: allBlocked });
    if (round % 10 === 9) console.log(JSON.stringify({ profile, scenario, seconds: round + 1, health: after.health, kills, cells: cells.size, stalled }));
  }
  const final = engine.state();
  const result = { protocol: 2, motorController: profile === 'game-aware' ? 'obstacle-recovery-v1' : 'legacy', deathStopsImmediately: true, profile, split, scenario, setup: cases[scenario], objective, maxGameSeconds: rounds, initial, final, gameSeconds: (final.tick - initial.tick) / 35, alive: final.alive, exited: final.map !== initial.map || final.phase === 'intermission', damage, kills, ammoSpent, blockedShots, noTargetShots, stalled, visitedCells: cells.size, decisions };
  await writeFile(file, JSON.stringify(result, null, 2));
  const { decisions: _, initial: __, final: ___, ...summary } = result;
  console.log(JSON.stringify(summary));
}
