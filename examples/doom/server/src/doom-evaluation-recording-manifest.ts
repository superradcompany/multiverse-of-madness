import { z } from 'zod';
import type { ReplayPath } from '@multiverse/gameplay-harness';

export interface DoomEvaluationRecordingManifest {
  version: 1;
  state: 'recording' | 'finished';
  /** Selected ancestry observed in this test run, starting at its scenario state. */
  path?: ReplayPath;
  /** Final observed main-world tick, used to detect an incompletely recorded tail. */
  endpointTick?: number;
  error?: string;
}

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  version: z.literal(1), state: z.enum(['recording', 'finished']),
  path: z.object({
    endpointId: z.string(), frames: position, firstTick: position, lastTick: position, missingHistory: z.boolean(),
    segments: z.array(z.object({ worldId: z.string(), label: z.string(), firstFrame: position, ticks: z.array(position) })),
  }).optional(),
  endpointTick: position.optional(), error: z.string().optional(),
});

export function decodeDoomEvaluationRecordingManifest(value: unknown): DoomEvaluationRecordingManifest {
  return schema.parse(value);
}
