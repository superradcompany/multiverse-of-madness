// Real Jev context-budget check. Does not advance the production game.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { DoomEngine } from '../packages/game-bridge/src/engine.ts';
import { Jev } from '../apps/server/src/jev.ts';
import { validateSkills } from '../apps/server/src/ai-skills.ts';
import { ExperienceMemory } from '../apps/server/src/experience.ts';
import { ACTIVE_SKILL_BUDGET, skillSize } from '../packages/contracts/src/skills.ts';
const state = (await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state();
const skills = [
  { id: '4f86d319-f385-4895-90a1-956ebcfb9b99', name: 'Combat', instructions: 'Only shoot when a target is visible, aligned, in range, and not behind a wall. '.repeat(26).slice(0, 1800), enabled: true },
  { id: '0f86d319-f385-4895-90a1-956ebcfb9b99', name: 'Navigation', instructions: 'Avoid repeating failed routes. Prefer unexplored space. '.repeat(20), enabled: true },
];
while (skillSize(skills) > ACTIVE_SKILL_BUDGET) skills[1]!.instructions = skills[1]!.instructions.slice(0, -1);
validateSkills(skills);
const memory = new ExperienceMemory();
for (let i = 0; i < 8; i++) memory.remember(`skill-${i}`, 'explore an opening', state, { ...state, tick: state.tick + 70, x: state.x + 32 });
const guide = 'Preserve health, use relevant skills, defeat visible enemies and reach new areas. '.repeat(20).slice(0, 1000);
const results = [];
for (const planTicks of [undefined, 210]) {
  const result = await new Jev().decide(state, guide, [], AbortSignal.timeout(15000), memory.records, 35, { planTicks, skills });
  assert.equal(result.evidence?.skills?.length, 2);
  assert.deepEqual(result.evidence?.skills?.map(s => s.instructions), skills.map(s => s.instructions));
  results.push({ mode: planTicks ? 'plans' : 'actions', skills: result.evidence!.skills!.map(s => s.name), memoryUsed: result.experienceUsed, selected: result.plans?.selected ?? result.action });
}
await mkdir('artifacts/skills', { recursive: true });
const report = { created: new Date().toISOString(), skillCharacters: skillSize(skills), guideCharacters: guide.length, results };
await writeFile('artifacts/skills/context-budget.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
