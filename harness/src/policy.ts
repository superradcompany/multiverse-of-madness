import type { VersionRef } from './contracts.ts';

export type ReadonlyValue<T> = T extends readonly (infer Item)[] ? readonly ReadonlyValue<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyValue<T[Key]> } : T;
export type PolicyPatch<T> = { [Key in keyof T]?: T[Key] extends readonly unknown[] ? T[Key]
  : T[Key] extends object ? PolicyPatch<T[Key]> : T[Key] };
export type PolicyLayerName = 'defaults' | 'adapter' | 'profile' | 'session';
export interface PolicyLayer<T> { revision: VersionRef; patch: PolicyPatch<T> }
export interface PolicySchema<T extends object> {
  version: VersionRef;
  defaults: T;
  /** Reject unknown fields and validate domain constraints; do not silently strip. */
  parse(value: unknown): T;
}
export interface ResolvedPolicy<T> {
  schema: VersionRef;
  values: T;
  layers: Array<PolicyLayer<T> & { name: PolicyLayerName }>;
}

/** Resolve explicit layers in fixed precedence. Objects merge; arrays replace. */
export function resolvePolicy<T extends object>(schema: PolicySchema<T>, layers: Partial<Record<Exclude<PolicyLayerName, 'defaults'>, PolicyLayer<T>>> = {}): ReadonlyValue<ResolvedPolicy<T>> {
  validateVersion(schema.version);
  let values = copy(schema.parse(copy(schema.defaults)));
  const applied: ResolvedPolicy<T>['layers'] = [{ name: 'defaults', revision: copy(schema.version), patch: copy(values) }];
  for (const name of ['adapter', 'profile', 'session'] as const) {
    const layer = layers[name];
    if (!layer) continue;
    validateVersion(layer.revision);
    const patch = copy(layer.patch);
    values = copy(schema.parse(merge(values, patch)));
    applied.push({ name, revision: copy(layer.revision), patch });
  }
  return freeze({ schema: copy(schema.version), values, layers: applied });
}

/** Stable JSON for content identities. Rejects lossy values instead of hiding them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}
function normalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || !value) throw new Error('Policy values must be finite JSON data');
  if (ancestors.has(value)) throw new Error('Policy values cannot be cyclic');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Policy values must use plain objects');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Policy values cannot contain symbol keys');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error('Policy arrays cannot be sparse or have extra properties');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('Policy arrays cannot contain accessors');
        return normalize(descriptor.value, ancestors);
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe policy field');
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Policy fields must be enumerable data');
      result[key] = normalize(descriptor.value, ancestors);
    }
    return result;
  } finally { ancestors.delete(value); }
}
function copy<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function merge(base: unknown, patch: unknown): unknown {
  if (!object(base) || !object(patch)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = merge(result[key], value);
  return result;
}
function freeze<T>(value: T): ReadonlyValue<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as ReadonlyValue<T>;
}
function validateVersion(value: VersionRef): void {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || typeof value.version !== 'string' || !value.version.trim()) throw new Error('Policy layers require explicit identities and versions');
}
