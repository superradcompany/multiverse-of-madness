import type { Capability, GameCapabilities, PlanDefinition } from './contracts.ts';
import { canonicalJson } from './policy.ts';

const features = ['exactFork', 'checkpoint', 'restore', 'detached', 'render'] as const satisfies readonly Capability[];

/** An explicitly unsupported operation. Callers may report it without treating it as a runtime crash. */
export class UnsupportedGameCapabilities extends Error {
  readonly missing: readonly Capability[];
  constructor(readonly operation: string, missing: readonly Capability[]) {
    super(`${operation} requires unsupported game capabilities: ${missing.join(', ')}`);
    this.name = 'UnsupportedGameCapabilities';
    this.missing = Object.freeze([...missing]);
  }
}

/** Validate the declaration, not the truth of a runtime's implementation. Exactness needs engine qualification. */
export function validateGameCapabilities(value: unknown): asserts value is GameCapabilities {
  canonicalJson(value); // Refuse accessors and non-JSON values before reading fields.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid game capabilities');
  const record = value as Record<string, unknown>, keys = ['observations', ...features];
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw new Error('Invalid game capability fields');
  if (!['structured', 'visual', 'mixed'].includes(record.observations as string)) throw new Error('Invalid observation capability');
  for (const key of features) if (typeof record[key] !== 'boolean') throw new Error(`Invalid capability ${key}`);
}

/** Preflight before publishing intent, allocating resources or dispatching work. No fallback is selected. */
export function requireGameCapabilities(capabilities: GameCapabilities, required: readonly Capability[], operation: string): void {
  validateGameCapabilities(capabilities);
  canonicalJson(required);
  if (!Array.isArray(required) || new Set(required).size !== required.length
    || required.some(key => !features.includes(key))) throw new Error('Invalid required game capabilities');
  if (typeof operation !== 'string' || !operation.trim()) throw new Error('Capability check requires an operation name');
  const needs: readonly Capability[] = required;
  const missing = needs.filter(key => capabilities[key] !== true);
  if (missing.length) throw new UnsupportedGameCapabilities(operation, missing);
}

/** Validate a host-supplied plan before model preparation/selection and again before execution. */
export function requirePlanCapabilities(plan: Pick<PlanDefinition<unknown>, 'id' | 'requires'>, capabilities: GameCapabilities): void {
  if (!plan || typeof plan.id !== 'string' || !plan.id.trim()) throw new Error('Capability check requires a plan identity');
  requireGameCapabilities(capabilities, plan.requires, `Plan ${plan.id}`);
}
