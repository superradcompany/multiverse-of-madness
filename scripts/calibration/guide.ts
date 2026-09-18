// Paired real-Jev judgments over frozen engine observations. No live game changes.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { Jev } from '../../examples/doom/server/src/jev.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { candidatePlans } from '../../examples/doom/server/src/doom-plans.ts';
import { decisionStatistics } from '../../examples/doom/server/src/decision-context.ts';
import { initialStats } from '../../examples/doom/server/src/run-stats.ts';
import { ExperienceMemory } from '../../examples/doom/server/src/experience.ts';
import type { GameState } from '../../examples/doom/contracts/src/game.ts';

const root = 'artifacts/calibration/validated';
const examples: Array<{ file: string; state: GameState }> = [];
for (const file of (await readdir(root)).filter(f => /^play-.*heldout-.*\.json$/.test(f)).sort()) {
  const run = JSON.parse(await readFile(`${root}/${file}`, 'utf8'));
  for (const entry of run.decisions) {
    const state: GameState = entry.before;
    if (!state.alive || examples.some(e => Math.hypot(e.state.x - state.x, e.state.y - state.y) < 96)) continue;
    const plans = candidatePlans(state, await geometryFor(state, true, true));
    if (plans.some(p => p.id === 'engage') && plans.some(p => p.id === 'recover')) { examples.push({ file, state }); break; }
  }
  if (examples.length === 3) break;
}
if (!examples.length) throw new Error('No frozen states offer both combat and health recovery');
const jev = new Jev();
const results = [];
for (const example of examples) {
  const stats = initialStats(example.state, true);
  for (const [expected, guide] of Object.entries({ engage: 'Defeat the nearby enemy now. Prioritize combat over collecting optional health.', recover: 'Avoid fighting. Collect the nearby health before engaging enemies.' })) {
    const decision = await jev.decide(example.state, guide, [], AbortSignal.timeout(15000), [], 35,
      { planTicks: 210, stats: decisionStatistics(example.state, stats), visited: stats.visited });
    results.push({ file: example.file, tick: example.state.tick, guide, expected, selected: decision.plans!.selected,
      priority: decision.priority, probabilities: decision.plans!.candidates.map(p => ({ id: p.id, probability: p.probability })) });
  }
}
// Exercise a long guide plus the maximum eight relevant memories on the real API.
const state = examples[0]!.state, memory = new ExperienceMemory();
for (let i = 0; i < 8; i++) memory.remember(`budget-${i}`, 'engage the enemy', state, { ...state, tick: state.tick + 70, kills: state.kills + 1 });
const guide = 'Preserve health while defeating visible enemies and reaching unexplored space. '.repeat(13).slice(0, 1000);
const budget = await jev.decide(state, guide, [], AbortSignal.timeout(15000), memory.records, 35, { planTicks: 210 });
const report = { created: new Date().toISOString(), scope: 'Real Jev judgments on frozen engine observations, not live gameplay or a win-rate benchmark', results,
  matched: results.filter(r => r.expected === r.selected).length, total: results.length,
  budget: { guideCharacters: guide.length, suppliedAttempts: 8, usedAttempts: budget.experienceUsed, selected: budget.plans!.selected } };
await mkdir('artifacts/guide', { recursive: true });
await writeFile('artifacts/guide/paired.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
