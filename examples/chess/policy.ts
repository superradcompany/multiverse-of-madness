import { resolvePolicy } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { ChessPolicy } from './session-types.ts';

export const defaultChessPolicy: ChessPolicy = { threshold: .75, breadth: 2, trialPlies: 2, checkpointEvery: 4, checkpointLimit: 3, memoryCapacity: 64 };
export function resolveChessPolicy(policy: ChessPolicy) {
  const resolved = resolvePolicy({ version: { id: 'chess-policy', version: '1' }, defaults: defaultChessPolicy, parse: parseChessPolicy },
    { profile: { revision: contentRevision('chess-profile', policy), patch: policy } });
  return { policy: Object.freeze(structuredClone(resolved.values)), revision: contentRevision('chess-policy', resolved) };
}
export function parseChessPolicy(input: unknown): ChessPolicy {
  const value = input as ChessPolicy;
  if (!value || Object.keys(value).sort().join() !== Object.keys(defaultChessPolicy).sort().join() || !Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1
    || !Number.isSafeInteger(value.breadth) || value.breadth < 1 || value.breadth > 8 || !Number.isSafeInteger(value.trialPlies) || value.trialPlies < 1 || value.trialPlies > 32
    || !Number.isSafeInteger(value.checkpointEvery) || value.checkpointEvery < 1 || !Number.isSafeInteger(value.checkpointLimit) || value.checkpointLimit < 1
    || !Number.isSafeInteger(value.memoryCapacity) || value.memoryCapacity < 8 || value.memoryCapacity > 10000) throw new Error('Invalid chess policy');
  return value;
}
