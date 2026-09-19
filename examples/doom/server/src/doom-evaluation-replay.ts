import { join } from 'node:path';
import { z } from 'zod';
import type { EvaluationReplayFrame } from '../../contracts/src/learning-evaluation.ts';
import { RecordingReader } from './recording-reader.ts';

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pathSchema = z.object({
  endpointId: z.string(), frames: position, firstTick: position, lastTick: position, missingHistory: z.boolean(),
  segments: z.array(z.object({ worldId: z.string(), label: z.string(), firstFrame: position, ticks: z.array(position) })),
});
const manifestSchema = z.object({ version: z.literal(1), state: z.literal('finished'),
  endpointTick: position.optional(), path: pathSchema, error: z.string().optional() });

/** Frozen selected path, read without opening a mutable recording store. */
export class DoomEvaluationReplay {
  readonly manifest;
  private readonly points: Array<{ worldId: string; frame: number; tick: number }>;
  private readonly reader: RecordingReader;

  constructor(directory: string, value: unknown) {
    this.manifest = manifestSchema.parse(value);
    const path = this.manifest.path;
    this.points = path.segments.flatMap(segment => segment.ticks.map((tick, offset) => ({
      worldId: segment.worldId, frame: segment.firstFrame + offset, tick,
    })));
    if (this.points.length !== path.frames || !path.frames
      || this.points[0]!.tick !== path.firstTick || this.points.at(-1)!.tick !== path.lastTick
      || this.points.some((point, index) => index > 0 && point.tick <= this.points[index - 1]!.tick)) {
      throw new Error('Invalid evaluation replay path');
    }
    this.reader = new RecordingReader(join(directory, 'recordings'), {
      list: () => ({ worlds: path.segments.map(segment => ({ id: segment.worldId, firstFrame: segment.firstFrame, frames: segment.ticks.length })) }),
      get: async () => { throw new Error('Evaluation recording frame is unavailable'); },
    });
  }

  /** Bounded batches avoid one HTTP request per gameplay frame. */
  async frames(start: number, count: number): Promise<EvaluationReplayFrame[]> {
    if (!Number.isSafeInteger(start) || start < 0 || start >= this.points.length
      || !Number.isSafeInteger(count) || count < 1 || count > 35) throw new Error('Invalid evaluation replay range');
    return Promise.all(this.points.slice(start, start + count).map(async (point, offset) => {
      const saved = await this.reader.get(point.worldId, point.frame);
      if (saved.world.state.tick !== point.tick) throw new Error('Evaluation recording tick mismatch');
      return { index: start + offset, tick: point.tick, frame: saved.frame,
        label: saved.world.label, health: saved.world.state.health, kills: saved.world.state.kills };
    }));
  }
}
