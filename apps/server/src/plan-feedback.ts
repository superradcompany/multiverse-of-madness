import type { GameState } from '../../../packages/contracts/src/game.ts';
import type { PlanExecution } from './doom-plans.ts';

/** Observed local plan outcome, derived from the world's existing durable plan. */
export function previousPlanFeedback(run: PlanExecution | undefined, current: GameState) {
  if (!run || run.status === 'running' || current.episode !== run.started.episode || current.map !== run.started.map
    || current.tick < run.started.tick) return undefined;
  const step = run.plan.steps[Math.min(run.step, run.plan.steps.length - 1)];
  return {
    id: run.plan.id.slice(0, 64), label: run.plan.label.slice(0, 120), status: run.status,
    reason: run.reason?.slice(0, 160), step: run.step, target: step ? { ...(run.tracked ?? step.target) } : undefined,
    episode: current.episode, map: current.map, startedTick: run.started.tick, observedTick: current.tick,
    // This is time since the plan began, not a claim about its execution duration.
    ticksSinceStarted: current.tick - run.started.tick,
  };
}
export type PreviousPlanFeedback = NonNullable<ReturnType<typeof previousPlanFeedback>>;

/** These observed stops indicate missing/ineffective candidates, rather than normal completion or fresh threats. */
export function failedPlanFeedback(run: PlanExecution, current: GameState): PreviousPlanFeedback | undefined {
  if (run.status !== 'replan' || !new Set(['target became obstructed', 'target lost or ambiguous', 'step time limit reached',
    'interaction out of reach', 'strafe route blocked', 'route blocked']).has(run.reason ?? '')) return;
  return previousPlanFeedback(run, current);
}
