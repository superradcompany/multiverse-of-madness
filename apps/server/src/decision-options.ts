import type { DecisionOptionsView } from '../../../packages/contracts/src/session.ts';
import { actions, type Decision } from './jev.ts';

/** A bounded observer projection of the actual menu Jev received, not invented future options. */
export function decisionOptionsView(decision: Decision, tick: number, previous?: DecisionOptionsView): DecisionOptionsView {
  const options = decision.plans ? decision.plans.candidates.map(plan => ({ id: plan.id, label: plan.label,
    steps: plan.steps.map(step => step.label), ...(plan.evidence ? { evidence: plan.evidence.slice(0, 500) } : {}) }))
    : (Object.keys(decision.probabilities) as Array<keyof typeof actions>).filter(id => !decision.perception?.excludedActions.includes(id)).map(id => ({ id, label: actions[id as keyof typeof actions].label }));
  const kind = decision.plans ? 'plans' : 'actions';
  const before = new Map(previous?.options.map(option => [option.id, option]) ?? []), after = new Map(options.map(option => [option.id, option]));
  const added = options.filter(option => !before.has(option.id)).map(option => option.label);
  const removed = [...before.values()].filter(option => !after.has(option.id)).map(option => option.label);
  const updated = options.filter(option => before.has(option.id) && JSON.stringify(before.get(option.id)) !== JSON.stringify(option)).map(option => option.label);
  const changes = previous && (added.length || removed.length || updated.length) ? { tick, added, removed, updated } : previous?.changes;
  return { tick, kind, selected: decision.plans?.selected ?? decision.action, options, ...(changes ? { changes } : {}) };
}
