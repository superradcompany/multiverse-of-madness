import { createHash } from 'node:crypto';
import type { VersionRef } from '../contracts.ts';
import { canonicalJson } from '../policy.ts';

/** Content identity for a serializable policy, manifest or evaluation contract. */
export function contentRevision(id: string, value: unknown): VersionRef {
  if (!id.trim()) throw new Error('Revision identity must not be empty');
  return { id, version: `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}` };
}
