import type { GameCapabilities, VersionRef } from './contracts.ts';
import { canonicalJson } from './policy.ts';

/** Host-authored field semantics. Paths are JSON pointers relative to the described object. */
export interface GameFieldDescription {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  meaning: string;
  availability: 'always' | 'conditional';
}
/** Portable mechanics, not a strategy, private test set or permission to change host rules. */
export interface GameDescription {
  format: 1;
  adapter: VersionRef;
  name: string;
  observations: GameFieldDescription[];
  controls: Array<{
    id: string;
    meaning: string;
    fields: GameFieldDescription[];
    /** Observation pointer containing legal choices, when the engine enumerates them. */
    legalChoices?: string;
    preconditions: string;
    effects: string;
  }>;
  timing: { unit: 'seconds' | 'turns'; sequence: string; commandDuration: string; waiting: string };
  planning: { payload: GameFieldDescription[]; execution: string; validation: string };
  outcomes: { success: string; failure: string; metrics: Array<{ id: string; meaning: string; direction: 'higher' | 'lower' | 'diagnostic' }> };
  capabilities: GameCapabilities;
  limitations: string[];
}

/** Check a description before exposing it to a supervisor. Runtime validation remains host-owned. */
export function validateGameDescription(value: unknown, expected?: { adapter: VersionRef; capabilities: GameCapabilities }): asserts value is GameDescription {
  // Reject accessors, cycles and non-JSON data before reading any supplied fields.
  if (canonicalJson(value).length > 65_536) throw new Error('Game description is too large');
  const root = object(value, ['format', 'adapter', 'name', 'observations', 'controls', 'timing', 'planning', 'outcomes', 'capabilities', 'limitations']);
  if (root.format !== 1) throw new Error('Unsupported game description format');
  const adapter = object(root.adapter, ['id', 'version']); text(adapter.id); text(adapter.version); text(root.name);
  const observations = fields(root.observations);
  const controls = list(root.controls, 1, 128);
  unique(controls.map(item => {
    const control = object(item, ['id', 'meaning', 'fields', 'preconditions', 'effects'], ['legalChoices']);
    text(control.id); text(control.meaning); fields(control.fields, 0); text(control.preconditions); text(control.effects);
    if (control.legalChoices !== undefined) {
      pointer(control.legalChoices);
      const choices = observations.find(field => field.path === control.legalChoices);
      if (!choices || choices.type !== 'array') throw new Error('Legal choices must reference a described observation array');
    }
    return control.id;
  }));
  const timing = object(root.timing, ['unit', 'sequence', 'commandDuration', 'waiting']);
  oneOf(timing.unit, ['seconds', 'turns']); pointer(timing.sequence); text(timing.commandDuration); text(timing.waiting);
  if (!observations.some(field => field.path === timing.sequence && field.type === 'number')) throw new Error('Clock must reference a described numeric observation');
  const planning = object(root.planning, ['payload', 'execution', 'validation']);
  fields(planning.payload, 0); text(planning.execution); text(planning.validation);
  const outcomes = object(root.outcomes, ['success', 'failure', 'metrics']); text(outcomes.success); text(outcomes.failure);
  unique(list(outcomes.metrics, 1, 128).map(item => {
    const metric = object(item, ['id', 'meaning', 'direction']); text(metric.id); text(metric.meaning); oneOf(metric.direction, ['higher', 'lower', 'diagnostic']); return metric.id;
  }));
  const capabilities = object(root.capabilities, ['observations', 'exactFork', 'checkpoint', 'restore', 'detached', 'render']);
  oneOf(capabilities.observations, ['structured', 'visual', 'mixed']);
  for (const key of ['exactFork', 'checkpoint', 'restore', 'detached', 'render']) if (typeof capabilities[key] !== 'boolean') throw new Error(`Invalid capability ${key}`);
  for (const limitation of list(root.limitations, 0, 128)) text(limitation);
  if (expected && (canonicalJson(adapter) !== canonicalJson(expected.adapter) || canonicalJson(capabilities) !== canonicalJson(expected.capabilities))) {
    throw new Error('Game description does not match the active adapter/runtime');
  }
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a game description object');
  const result = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Unexpected game description fields');
  return result;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error('Invalid game description text');
}
function pointer(value: unknown) {
  if (value === '') return; // The root pointer describes a scalar observation/command.
  text(value);
  if (!value.startsWith('/') || /~(?![01])/.test(value)) throw new Error('Expected a JSON pointer');
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('Invalid game description list');
  return value;
}
function oneOf(value: unknown, values: string[]) {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error('Invalid game description value');
}
function unique(values: unknown[]) { if (new Set(values).size !== values.length) throw new Error('Duplicate game description identifier'); }
function fields(value: unknown, min = 1): Array<Record<string, unknown>> {
  const result = list(value, min, 256).map(item => {
    const field = object(item, ['path', 'type', 'meaning', 'availability']);
    pointer(field.path); text(field.meaning); oneOf(field.type, ['string', 'number', 'boolean', 'object', 'array']); oneOf(field.availability, ['always', 'conditional']);
    return field;
  });
  unique(result.map(field => field.path)); return result;
}
