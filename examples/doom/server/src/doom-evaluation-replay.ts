import { join } from 'node:path';
import type { EvaluationReplayFrame } from '../../contracts/src/learning-evaluation.ts';
import { RecordingReader } from './recording-reader.ts';
import { decodeDoomEvaluationRecordingManifest } from './doom-evaluation-recording-manifest.ts';

/** Frozen selected path, read without opening a mutable recording store. */
export class DoomEvaluationReplay {
  readonly manifest;
  private readonly points: Array<{ worldId: string; frame: number; tick: number }>;
  private readonly reader: RecordingReader;

  constructor(directory: string, value: unknown) {
    this.manifest = decodeDoomEvaluationRecordingManifest(value);
    if (this.manifest.state !== 'finished' || !this.manifest.path) throw new Error('Evaluation replay is unavailable');
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
