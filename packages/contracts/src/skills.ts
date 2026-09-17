export interface AiSkill { id: string; name: string; instructions: string; enabled: boolean }
export const SKILL_LIMIT = 32;
export const SKILL_TEXT_LIMIT = 2000;
export const ACTIVE_SKILL_BUDGET = 2400;
export const activeSkills = (skills: AiSkill[]) => skills.filter(s => s.enabled).map(({ id, name, instructions }) => ({ id, name, instructions }));
export const skillSize = (skills: AiSkill[]) => JSON.stringify(activeSkills(skills)).length;
