import type { LearningRevision } from '@multiverse/gameplay-harness';
import type { GameState } from '../../contracts/src/game.ts';
import { activeSkills } from '../../contracts/src/skills.ts';
import type { DecisionContext } from './jev.ts';
import { geometryFor } from './doom-geometry.ts';
import { candidatePlans, weaponPlans } from './doom-plans.ts';
import { feedbackState } from './doom-context.ts';
import { decisionStatistics } from './decision-context.ts';
import type { Experience } from './experience.ts';
import type { DoomPolicy } from './doom-policy.ts';

/** Shared by execution and supervisor ABI examples so observed evidence cannot imply a different input shape. */
export async function doomPreparationInput(revision: LearningRevision<DoomPolicy>, state: GameState, objective: string,
  history: GameState[], experience: Experience[], actionTicks: number, context: DecisionContext) {
  const policy = context.policy ?? revision.policy;
  const pool = policy.memory.enabled ? context.experiencePool ?? experience : [];
  const map = await geometryFor(state, true, true);
  const input = { abi: 'doom-preparation/1', supportedOutputAbis: ['doom-preparation/1', 'doom-preparation/2', 'doom-preparation/3'], temporaryGoal: context.temporaryGoal, planningAhead: context.planningAhead, previousPlan: context.previousPlan, state, objective, history, experience: pool,
    experienceLimit: policy.memory.enabled ? policy.memory.perDecision : 0, planTicks: context.planTicks,
    actionTicks, stats: context.stats ?? decisionStatistics(state), userSkills: activeSkills(context.skills ?? []), visited: context.visited,
    feedback: feedbackState(state, objective, history, map, actionTicks, experience, context.previousAction),
    // Defaults use the same editable shape as returned plans. Host-only evidence
    // and novelty are not writable fields; step bounds match this invocation.
    defaultPlans: context.planTicks && state.phase === 'level' ? candidatePlans(state, map, context.visited, context.pickups)
      .filter(plan => !plan.steps.some(step => step.kind === 'equip'))
      .map(({ id, label, family, steps }) => ({ id, label, family, steps: steps.map(step => ({ ...step, maxTicks: Math.min(step.maxTicks, context.planTicks!) })) })) : undefined,
    // Kept separate so existing /1 and /2 programs can copy defaultPlans unchanged.
    weaponPlans: context.planTicks && state.phase === 'level' ? weaponPlans(state, map).map(plan => ({ ...plan,
      steps: plan.steps.map(step => ({ ...step, maxTicks: Math.min(step.maxTicks, context.planTicks!) })) })) : undefined,
    defaultHistoryIndices: history.map((_, i) => i),
    defaultExperienceIndices: experience.map(item => pool.findIndex(record => JSON.stringify(record) === JSON.stringify(item))).filter(index => index >= 0),
    learning: { revision: revision.revision, policy, prompts: revision.prompts, skills: revision.skills } };
  return JSON.parse(JSON.stringify(input)) as typeof input;
}
