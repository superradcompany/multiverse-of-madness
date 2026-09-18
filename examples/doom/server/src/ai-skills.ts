import { z } from 'zod';
import { ACTIVE_SKILL_BUDGET, SKILL_LIMIT, SKILL_TEXT_LIMIT, skillSize, type AiSkill } from '../../contracts/src/skills.ts';

export const skillInput = z.object({ name: z.string().trim().min(1).max(60), instructions: z.string().trim().min(1).max(SKILL_TEXT_LIMIT), enabled: z.boolean() });
export function validateSkills(skills: AiSkill[]) {
  const parsed = z.array(skillInput.extend({ id: z.string().uuid() })).max(SKILL_LIMIT).parse(skills);
  if (new Set(parsed.map(s => s.id)).size !== parsed.length) throw new Error('Duplicate skill identity');
  if (new Set(parsed.map(s => s.name.toLowerCase())).size !== parsed.length) throw new Error('Each skill needs a unique name');
  if (skillSize(parsed) > ACTIVE_SKILL_BUDGET) throw new Error(`Enabled skills exceed the ${ACTIVE_SKILL_BUDGET}-character context budget. Shorten instructions or disable another skill.`);
  return parsed;
}
