import type { SessionCheckpoint } from './session.ts';
import type { GamePlan } from './doom-plans.ts';
import type { WorldView } from '../../../packages/contracts/src/session.ts';

// Retire the experimental, code-imposed key strategy from saved live state.
// Game observations, user guide, recordings and ordinary model plans are kept.
export function discardForcedKeyStrategy(checkpoint: SessionCheckpoint): SessionCheckpoint {
  const saved = structuredClone(checkpoint);
  let changed = false;
  const retired = (plan?: GamePlan) => plan?.id === 'key-route' || plan?.id === 'unlock-route' || (plan?.family as string) === 'progression';
  const cleanView = (view: WorldView) => {
    if ('navigationGoal' in view) { delete view.navigationGoal; changed = true; }
    const trial = view.trial as WorldView['trial'] & { goalProgress?: number };
    if (trial && 'goalProgress' in trial) {
      if (view.score !== undefined) view.score -= trial.goalProgress ?? 0;
      delete trial.goalProgress; changed = true;
    }
  };
  for (const record of [...saved.worlds, ...(saved.recovery?.points ?? []).map(p => ({ ...p, view: p.world, source: p }))]) {
    const source = 'source' in record ? record.source : record;
    if ('progression' in source) { delete source.progression; changed = true; }
    cleanView(record.view);
    if (retired(source.plan?.plan)) {
      source.plan = undefined; record.view.plan = undefined; changed = true;
      if (record.view.role !== 'archived') { record.view.label = 'awaiting next decision'; record.view.currentAction = undefined; }
      const experiment = saved.experiments.find(e => e.id === record.view.id);
      if (experiment) experiment.nextDecisionTick = record.view.state.tick;
    }
  }
  for (const view of saved.view.worlds) cleanView(view);
  if (saved.pendingFork?.plans?.some(retired)) {
    saved.pendingFork.plans = saved.pendingFork.plans.map(p => retired(p) ? undefined : p);
    saved.pendingFork.skillsRevision = -1; // Re-judge recovered children before input.
    changed = true;
  }
  saved.view.worlds = saved.worlds.map(r => structuredClone(r.view));
  if (changed) {
    saved.view.decision = undefined; saved.view.confidence = undefined;
    saved.view.comparison = undefined; saved.view.reviewEndsAt = undefined;
  }
  return saved;
}
