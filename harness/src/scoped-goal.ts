import type { VersionRef } from './contracts.ts';
import { canonicalJson } from './policy.ts';

/** Host-owned identity and simulation clock, never assigned by generated guidance. */
export interface GoalFrame {
  /** Logical run/environment identity; exact child worlds may inherit the same scope. */
  scope: VersionRef;
  /** Changes when the user objective or authoritative constraints change. */
  context: VersionRef;
  /** Active strategy identity, including its activation epoch when rollback matters. */
  source: VersionRef;
  clock: { unit: string; value: number };
}
/** A proposal is advisory. The host still owns the primary objective and legal actions. */
export interface GoalDraft<Target> {
  instruction: string;
  reason: string;
  /** References to host-retained observations, not model-generated evidence claims. */
  evidence: string[];
  duration: number;
  target: Target;
}
export type GoalStatus = 'active' | 'completed' | 'failed' | 'expired' | 'invalidated';
/** Serializable branch-local record. Terminal outcomes never become active again. */
export interface ScopedGoal<Target> {
  format: 1;
  id: string;
  rules: VersionRef;
  draft: GoalDraft<Target>;
  created: GoalFrame;
  expiresAt: number;
  checked: GoalFrame;
  status: GoalStatus;
  outcome: string;
}
export interface ScopedGoalRules<Target> {
  version: VersionRef;
  /** In the adapter's simulation-clock units, not wall time or model tokens. */
  maxDuration: number;
  /** Reject unknown fields and unsupported targets using the game's mechanics. */
  parseTarget(value: unknown): Target;
  /** Resolve every proposed evidence reference against host-owned records. */
  hasEvidence(reference: string): boolean;
}
export interface GoalAssessment { status: 'active' | 'completed' | 'failed'; reason: string }

/** Stamp a validated proposal at the host's decision boundary without changing its objective. */
export function createScopedGoal<Target>(id: string, draft: GoalDraft<Target>, frame: GoalFrame,
  rules: ScopedGoalRules<Target>): ScopedGoal<Target> {
  canonicalJson({ id, draft, frame });
  const value = { format: 1, id, rules: rules.version, draft, created: frame,
    expiresAt: frame.clock.value + draft.duration, checked: frame, status: 'active', outcome: '' };
  const goal = decodeScopedGoal(value, rules);
  if (goal.draft.evidence.some(reference => !rules.hasEvidence(reference))) throw new Error('Goal references unavailable evidence');
  return goal;
}

/** Restore a record with an explicit target schema. Reading never reissues or extends it. */
export function decodeScopedGoal<Target>(value: unknown, rules: ScopedGoalRules<Target>): ScopedGoal<Target> {
  if (canonicalJson(value).length > 16_384) throw new Error('Scoped goal is too large');
  version(rules.version); duration(rules.maxDuration);
  const record = object(value, ['format', 'id', 'rules', 'draft', 'created', 'expiresAt', 'checked', 'status', 'outcome']);
  if (record.format !== 1) throw new Error('Unsupported scoped goal format');
  text(record.id, 160); version(record.rules);
  if (!same(record.rules, rules.version)) throw new Error('Scoped goal rules do not match this adapter');
  const draft = object(record.draft, ['instruction', 'reason', 'evidence', 'duration', 'target']);
  text(draft.instruction, 1000); text(draft.reason, 1000); duration(draft.duration);
  if (draft.duration > rules.maxDuration) throw new Error('Goal duration exceeds the host limit');
  if (!Array.isArray(draft.evidence) || draft.evidence.length < 1 || draft.evidence.length > 16
    || new Set(draft.evidence).size !== draft.evidence.length) throw new Error('Goal needs distinct evidence references');
  for (const reference of draft.evidence) text(reference, 240);
  const created = frame(record.created), checked = frame(record.checked);
  number(record.expiresAt);
  if (record.expiresAt !== created.clock.value + draft.duration || record.expiresAt <= created.clock.value) throw new Error('Invalid goal expiry');
  if (!['active', 'completed', 'failed', 'expired', 'invalidated'].includes(record.status as string)) throw new Error('Invalid goal status');
  if (typeof record.outcome !== 'string' || record.outcome.length > 1000
    || (record.status !== 'active' && !record.outcome.trim())) throw new Error('Invalid goal outcome');
  if (record.status === 'active' && invalidation(created, checked)) throw new Error('Active goal has stale scope or clock');
  if (record.status === 'active' && checked.clock.value >= record.expiresAt) throw new Error('Active goal has already expired');
  if (['completed', 'failed'].includes(record.status as string)
    && (invalidation(created, checked) || checked.clock.value >= record.expiresAt)) throw new Error('Goal assessment is outside its scope or lifetime');
  if (record.status === 'expired' && (invalidation(created, checked) || checked.clock.value < record.expiresAt)) throw new Error('Invalid expired goal record');
  const target = rules.parseTarget(structuredClone(draft.target));
  if (!same(target, draft.target)) throw new Error('Goal target parser must validate without silently rewriting');
  return structuredClone(value) as ScopedGoal<Target>;
}

/** Evaluate current host observations only after scope/freshness checks; never ask a model to grade itself. */
export function advanceScopedGoal<Target, Observation>(saved: ScopedGoal<Target>, current: GoalFrame,
  observation: Observation, rules: ScopedGoalRules<Target>, assess: (target: Target, observation: Observation) => GoalAssessment): ScopedGoal<Target> {
  const goal = decodeScopedGoal(saved, rules);
  canonicalJson(current); const now = frame(current);
  if (goal.status !== 'active') return goal;
  const stale = invalidation(goal.created, now) ?? (now.clock.value < goal.checked.clock.value ? 'Simulation clock moved backwards' : undefined);
  goal.checked = structuredClone(now);
  if (stale) { goal.status = 'invalidated'; goal.outcome = stale; }
  else if (now.clock.value >= goal.expiresAt) { goal.status = 'expired'; goal.outcome = 'Simulation-time deadline reached'; }
  else {
    const result = assess(structuredClone(goal.draft.target), structuredClone(observation));
    canonicalJson(result); object(result, ['status', 'reason']); text(result.reason, 1000);
    if (!['active', 'completed', 'failed'].includes(result.status)) throw new Error('Invalid host goal assessment');
    goal.status = result.status; goal.outcome = result.reason;
  }
  return goal;
}

function invalidation(created: GoalFrame, current: GoalFrame): string | undefined {
  if (!same(created.scope, current.scope)) return 'Run or environment scope changed';
  if (!same(created.context, current.context)) return 'User objective or authoritative constraints changed';
  if (!same(created.source, current.source)) return 'Active strategy changed';
  if (created.clock.unit !== current.clock.unit) return 'Simulation clock unit changed';
  if (current.clock.value < created.clock.value) return 'Simulation clock precedes goal creation';
  return undefined;
}
function frame(value: unknown): GoalFrame {
  const input = object(value, ['scope', 'context', 'source', 'clock']);
  version(input.scope); version(input.context); version(input.source);
  const clock = object(input.clock, ['unit', 'value']); text(clock.unit, 160); number(clock.value);
  return input as unknown as GoalFrame;
}
function version(value: unknown): asserts value is VersionRef {
  const input = object(value, ['id', 'version']); text(input.id, 240); text(input.version, 240);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected scoped goal fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('Invalid scoped goal text');
}
function number(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid goal clock');
}
function duration(value: unknown): asserts value is number {
  number(value); if (value === 0) throw new Error('Goal duration must be positive');
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
