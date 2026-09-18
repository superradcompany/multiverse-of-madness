import { activeSkills, type AiSkill } from '../../contracts/src/skills.ts';
import type { JsonValue } from '@typesafe-ai/sdk';
import type { GameState } from '../../contracts/src/game.ts';
import { initialStats, type TimelineStats } from './run-stats.ts';
import type { Experience } from './experience.ts';

export function decisionStatistics(state: GameState, stats: TimelineStats = initialStats(state, true)) {
  return {
    current: { keys: state.keys ?? 'unknown', recentInteractions: (state.progressEvents ?? []).filter(e=>e.kind==='locked'||e.kind==='key'||e.kind==='switch').slice(-3), tick: state.tick, map: `E${state.episode}M${state.map}`, phase: state.phase, alive: state.alive, health: state.health, armor: state.armor,
      weapon: state.weapon ?? 'unknown', ammo: { bullets: state.ammo[0] ?? 0, shells: state.ammo[1] ?? 0, cells: state.ammo[2] ?? 0, rockets: state.ammo[3] ?? 0 },
      mapKills: state.kills, mapItems: state.items, mapSecrets: state.secrets },
    route: { kills: stats.kills, items: stats.items, secrets: stats.secrets, levels: stats.levels, gameSeconds: Math.round(stats.ticks / 35 * 10) / 10,
      damage: stats.damage, healing: stats.healing, ammoSpent: stats.ammoSpent, exploredCells: stats.visited.length, partialHistory: stats.partial },
    progress: { secondsWithoutRecordedKill: stats.lastKillTick === undefined ? null : Math.max(0, Math.round((state.tick - stats.lastKillTick) / 35)), secondsWithoutProgress: Math.max(0, Math.round((state.tick - stats.lastProgressTick) / 35 * 10) / 10),
      definition: 'Progress means a new area, kill, pickup, secret, healing or level exit. Movement through known space alone is not progress.' },
    scope: 'This world and its inherited route, including its trial so far. Discarded sibling kills are not credited here.',
  };
}
export type DecisionStatistics = ReturnType<typeof decisionStatistics>;
export const guideInstructions = 'When `planningAhead` is present, the named plan is still executing. Select the next bounded plan to use when it yields; avoid returning to its target once reached unless useful for the objective. All supplied stats and observations are current at request time, not predictions or proof of future outcomes. Treat `objective` as the primary user guide for every judgment. An active `temporaryGoal` is advisory, bounded guidance from the planner; use it only when consistent with the user objective, user skills and observed mechanics. It is not evidence that the target is reachable or that its condition has occurred. Follow the user guide and its constraints over generic exploration preferences, within observed game mechanics. Use `stats` to judge urgency, resources and measured progress. Do not claim certainty or promise a one-shot kill when the observations cannot establish it. Avoid repeating movement without useful progress; prefer a feasible goal or a route toward new space. Never confuse distance moved with accomplishment. When `previousPlan` is present, use its observed status, reason and target to avoid retrying the same failed route without a relevant change in conditions. `ticksSinceStarted` is elapsed game time since that plan began; zero means it stopped before time advanced. Plan IDs may be reused for different targets, so compare the target and reason too. Apply relevant instructions from `skills` in every judgment. The current objective takes priority over conflicting skills; observed mechanics and available actions constrain all instructions. Skills are guidance, not executable tools.';

export function withDecisionContext<T extends object>(base: T, state: GameState, objective: string, stats: DecisionStatistics | undefined, attempts: Experience[], skills: AiSkill[] = []) {
  // All questions in the request receive this same envelope, including priority.
  const input: Record<string, unknown> = { ...base, objective: objective.slice(0, 1000), stats: stats ?? decisionStatistics(state),
    experience: attempts.slice(0, 8).map(e => ({ action: e.action.slice(0, 96), result: e.result })) };
  delete input.relatedAttempts;
  // Preserve guide and statistics. Remove less relevant evidence first and
  // report the actual supplied count, rather than pretending all memories fit.
  const evidence = input.experience as unknown[];
  const size = () => JSON.stringify(input).length;
  while (size() > 5000 && evidence.length) evidence.pop();
  for (const key of ['recentPlayerStates', 'pickups', 'projectiles', 'enemies']) {
    const entries = input[key];
    if (Array.isArray(entries)) while (size() > 5000 && entries.length > 1) entries.pop();
  }
  if (size() > 5500) throw new Error('Decision context exceeds the supported input budget');
  input.skills = activeSkills(skills);
  return { input: JSON.parse(JSON.stringify(input)) as Record<string, JsonValue>, experienceUsed: evidence.length };
}
