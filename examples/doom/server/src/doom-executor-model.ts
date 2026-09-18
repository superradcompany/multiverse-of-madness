import { z } from 'zod';
import { BudgetLedger, type ExecutableProvider, type ExecutorLimits, type ExecutorReceipt, type LearningRevision } from '@multiverse/gameplay-harness';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import { actions, feasibleActions, type ActionId, type Decision, type DecisionContext, type DecisionMaker } from './jev.ts';
import { feedbackState } from './doom-context.ts';
import { geometryFor } from './doom-geometry.ts';
import { bearingTo, candidatePlans, type GamePlan } from './doom-plans.ts';
import { decisionStatistics } from './decision-context.ts';
import { activeSkills } from '../../contracts/src/skills.ts';
import type { GameState } from '../../contracts/src/game.ts';
import type { Experience } from './experience.ts';
import type { DoomPolicy } from './doom-policy.ts';

const probability = z.number().min(0).max(1);
const answer = z.strictObject({ selected: z.string(), confidence: probability, priority: z.enum(['survival', 'exploration', 'combat']),
  preferences: z.array(z.strictObject({ id: z.string(), probability })) });
export interface DoomExecutorDecision { revision: LearningRevision<DoomPolicy>; input: unknown; output: unknown; receipt: ExecutorReceipt }
type Candidate = { id: string; label: string; plan?: GamePlan };

/** Learning code ranks host-owned feasible actions/plans. It cannot submit arbitrary game commands or scores. */
export class DoomExecutableModel implements DecisionMaker {
  private readonly revision: LearningRevision<DoomPolicy>;
  private readonly limits: ExecutorLimits;
  constructor(revision: LearningRevision<DoomPolicy>, private readonly options: {
    store: ExecutableStore; executor: ExecutableProvider; ledger: BudgetLedger; limits: ExecutorLimits;
    record(decision: DoomExecutorDecision): Promise<void>;
  }) { this.revision = structuredClone(revision); this.limits = { ...options.limits }; }

  async decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal,
    experience: Experience[] = [], actionTicks = 35, context: DecisionContext = {}): Promise<Decision> {
    signal.throwIfAborted();
    // Freeze observations before asynchronous map/provider work. User edits trigger the session's freshness check.
    [state, history, experience, context] = structuredClone([state, history, experience, context]);
    const started = performance.now(), map = await geometryFor(state, true, true);
    const feedback = feedbackState(state, objective, history, map, actionTicks, experience, context.previousAction);
    const plans = context.planTicks && state.phase === 'level' ? candidatePlans(state, map, context.visited, context.pickups) : undefined;
    const feasible = feasibleActions(feedback);
    const candidates: Candidate[] = plans ? plans.map(plan => ({ id: plan.id, label: plan.label, plan }))
      : Object.entries(feasible).map(([id, label]) => ({ id, label }));
    if (!candidates.length) throw new Error('No feasible Doom candidates');
    const stats = context.stats ?? decisionStatistics(state), revision = this.revision;
    // JSON wire values intentionally omit unavailable optional observation fields.
    const input: unknown = JSON.parse(JSON.stringify({ state, objective, history, experience, actionTicks, planTicks: context.planTicks,
      feedback, previousPlan: context.previousPlan, stats, userSkills: activeSkills(context.skills ?? []), candidates,
      learning: { revision: revision.revision, policy: context.policy ?? revision.policy, basePolicy: revision.policy, prompts: revision.prompts, skills: revision.skills } }));
    const value = await this.options.ledger.run({ owner: revision.revision.version, operation: 'doom-learning-executor', reserve: { executorCalls: 1 }, observe: ['executorWallMs'] }, async () => {
      const executed = await this.options.executor.execute(await this.options.store.get(revision.executor), input, this.limits, signal);
      await this.options.record({ revision: structuredClone(revision), input, output: executed.value, receipt: executed.receipt });
      return { value: executed.value, usage: { executorCalls: 1, executorWallMs: executed.receipt.elapsedMs } };
    }, signal);
    const result = answer.parse(value), ids = new Set(candidates.map(candidate => candidate.id));
    if (!ids.has(result.selected) || result.preferences.length !== ids.size || new Set(result.preferences.map(item => item.id)).size !== ids.size
      || result.preferences.some(item => !ids.has(item.id)) || Math.abs(result.preferences.reduce((sum, item) => sum + item.probability, 0) - 1) > .000001) {
      throw new Error('Executor returned an invalid Doom decision');
    }
    const weights = new Map(result.preferences.map(item => [item.id, item.probability]));
    if (result.preferences.some(item => item.probability > weights.get(result.selected)!)) throw new Error('Executor selected a lower-ranked Doom candidate');
    const actionIds = Object.keys(actions) as ActionId[];
    const common = { confidence: result.confidence, priority: result.priority, latencyMs: performance.now() - started,
      model: `${revision.model.id}@${revision.model.version}`, experienceUsed: experience.length,
      evidence: { workingGuide: revision.prompts.guide, previousPlan: context.previousPlan, objective, stats, skills: activeSkills(context.skills ?? []), experienceUsed: experience.length } };
    if (plans) {
      const ranked = plans.map(plan => ({ ...plan, probability: weights.get(plan.id)! }));
      const opening = (plan: GamePlan): ActionId => { const angle = bearingTo(state, plan.steps[0]!.target); return angle > 7 ? 'left' : angle < -7 ? 'right' : 'advance'; };
      return { ...common, action: opening(ranked.find(plan => plan.id === result.selected)!), plans: { selected: result.selected, candidates: ranked },
        probabilities: Object.fromEntries(actionIds.map(id => [id, ranked.filter(plan => opening(plan) === id).reduce((sum, plan) => sum + plan.probability, 0)])) as Record<ActionId, number> };
    }
    return { ...common, action: result.selected as ActionId,
      probabilities: Object.fromEntries(actionIds.map(id => [id, weights.get(id) ?? 0])) as Record<ActionId, number>,
      perception: { profile: 'game-aware', blockedEnemies: feedback.blockedEnemyCount,
        uncertainTargets: feedback.targetsNotBehindSolidWalls.filter(enemy => enemy.visibility === 'dynamic-opening-unknown').length,
        forwardBarrier: feedback.movement.barrierDistances.ahead, movementFailed: feedback.movementFailed,
        excludedActions: actionIds.filter(id => !ids.has(id)) } };
  }
}
