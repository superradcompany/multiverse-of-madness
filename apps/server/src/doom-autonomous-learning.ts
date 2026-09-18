import { z } from 'zod';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { LearningObservation } from '@multiverse/gameplay-harness';
import type { SessionView } from '../../../packages/contracts/src/session.ts';

export const supervisorReviewIntervalMs = 120_000;
export const supervisorPersistentReviewIntervalMs = 300_000;
export const doomLearningMark = z.strictObject({ key: z.string(), objective: z.string().optional(), issues: z.array(z.enum(['goal-changed', 'strategy-bootstrap', 'plan-coverage', 'failed-outcomes', 'stalled-progress'])), seconds: z.number().nonnegative(), failures: z.number().int().nonnegative(), planFailures: z.number().int().nonnegative(), observedAt: z.number().nonnegative().optional(), selectedSeconds: z.number().nonnegative().optional() });
export type DoomLearningMark = z.infer<typeof doomLearningMark>;
export const doomAutonomousState = z.strictObject({
  version: z.literal(1), enabled: z.boolean(), lastObservation: doomLearningMark.optional(),
  cycle: z.strictObject({ mark: doomLearningMark, reason: z.string(), proposalId: z.string().uuid(), evaluationId: z.string().uuid() }).optional(),
  lastOutcome: z.strictObject({ proposalId: z.string().uuid(), status: z.string(), reason: z.string().optional() }).optional(), error: z.string().optional(),
});

/** Coalesce edits without a model call or a gameplay timer. Only applied goals can be reviewed. */
export class DoomGoalReview {
  private latest?: string;
  private changedAt = 0;
  constructor(readonly initialObjective: string) {}
  settled(objective: string, now: number): boolean {
    if (objective !== this.latest) { this.latest = objective; this.changedAt = now; }
    return now - this.changedAt >= 3000;
  }
}

/** Free, deterministic escalation detection. Successful routine play never schedules a supervisor call. */
export function observeDoomLearning(view: SessionView, previous?: DoomLearningMark, now = Date.now(), options: { bootstrapPlanner?: boolean; initialObjective?: string; goalSettled?: boolean } = {}): LearningObservation<DoomLearningMark> | undefined {
  const stats = view.stats, world = view.worlds.find(world => world.id === view.mainId);
  if (!stats || !world || world.controller === 'human' || view.pendingObjective) return;
  const attempts = stats.attempts, seconds = attempts.seconds;
  // Persisted wall time also spaces requests across fast simulations and game resets.
  // An elapsed interval alone never triggers a request; fresh evidence is still required.
  if (previous?.observedAt !== undefined && now - previous.observedAt < supervisorReviewIntervalMs) return;
  const failures = attempts.deaths + attempts.rejectedBatches + attempts.rollbacks, planFailures = attempts.planFailures ?? 0;
  const reset = previous && (seconds < previous.seconds || failures < previous.failures || planFailures < previous.planFailures);
  const before = reset ? undefined : previous;
  const previousObjective = previous?.objective ?? options.initialObjective;
  const goalChanged = previousObjective !== undefined && view.objective !== previousObjective
    && !view.pendingObjective && options.goalSettled === true;
  const bootstrap = options.bootstrapPlanner && !previous && view.planningMode === 'plans' && seconds >= 10;
  const issue = goalChanged ? 'goal-changed' : bootstrap ? 'strategy-bootstrap' : planFailures - (before?.planFailures ?? 0) >= 3 ? 'plan-coverage'
    : failures - (before?.failures ?? 0) >= 3 ? 'failed-outcomes'
    : (stats.stalledSeconds ?? 0) >= 15 && seconds - (before?.seconds ?? 0) >= 10 ? 'stalled-progress' : undefined;
  if (!issue) return;
  // Coalesce an unchanged failure cluster even if it repeats every turn. A changed goal,
  // learned revision, map, meaningful route progress or resource deterioration permits new analysis.
  const key = learningKey(view);
  if (key === before?.key && before.issues.includes(issue)) {
    // Repeated unsuccessful play is fresh evidence, even when the room, score
    // and health band do not change. Bound paid reviews by both wall and game time.
    const sustained = (stats.stalledSeconds ?? 0) >= 60 && before.observedAt !== undefined
      && now - before.observedAt >= supervisorPersistentReviewIntervalMs
      && before.selectedSeconds !== undefined && stats.seconds - before.selectedSeconds >= 60;
    if (!sustained) return;
  }
  return { mark: { key, objective: view.objective, issues: key === before?.key ? [...new Set<DoomLearningMark['issues'][number]>([...before.issues, issue])] : [issue], seconds, selectedSeconds: stats.seconds, failures, planFailures, observedAt: now }, reason: issue === 'goal-changed' ? 'The user changed the goal; adapt guidance and available options to the current objective while preserving its constraints' : issue === 'strategy-bootstrap' ? 'Create a reusable candidate planner from the game contract and initial observed play' : issue === 'plan-coverage'
    ? 'Repeated obstructed, unreachable or timed-out plans suggest a missing candidate or route'
    : issue === 'failed-outcomes' ? 'Repeated failed futures, rejected outcomes or rollbacks need strategic review'
    : 'The selected route has made no useful progress for at least 15 game seconds' };
}

/** Stalled execution needs new executable choices when the user has enabled plans. */
export function doomAutomaticProposalKind(issue: DoomLearningMark['issues'][number] | undefined, mode: SessionView['planningMode']) {
  return mode !== 'actions' && (issue === 'goal-changed' || issue === 'strategy-bootstrap' || issue === 'plan-coverage' || issue === 'stalled-progress') ? 'planner' as const : 'guidance' as const;
}

/** Start the next review window at activation, not at the old proposal's capture time. */
export function doomActivationObservation(view: SessionView, now = Date.now()): DoomLearningMark {
  if (!view.stats || !view.worlds.some(world => world.id === view.mainId)) throw new Error('Activation observation requires the current main world and statistics');
  const stats = view.stats, attempts = stats.attempts;
  return { key: learningKey(view), objective: view.objective, issues: [], seconds: attempts.seconds,
    selectedSeconds: stats.seconds, failures: attempts.deaths + attempts.rejectedBatches + attempts.rollbacks,
    planFailures: attempts.planFailures ?? 0, observedAt: now };
}
function learningKey(view: SessionView): string {
  const stats = view.stats!, world = view.worlds.find(world => world.id === view.mainId)!;
  return contentRevision('supervisor-issue', { objective: view.pendingObjective ?? view.objective,
    skillsRevision: view.skillsRevision ?? 0, revision: world.learning?.activation ?? null,
    episode: world.state.episode, map: world.state.map, cells: stats.cells, kills: stats.kills, items: stats.items,
    levels: stats.levels, healthBand: Math.floor(stats.health / 25) }).version;
}
