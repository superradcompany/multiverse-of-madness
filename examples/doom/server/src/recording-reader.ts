import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { Recordings } from './recordings.ts';

type Frame = Awaited<ReturnType<Recordings['get']>>;
/** Live stores and finalized manifests supply the same retained-frame boundary. */
export interface RecordingReadOwner {
  list(): { worlds: Array<{ id: string; firstFrame: number; frames: number }> };
  get: Recordings['get'];
}
type Index = { id: string; firstFrame?: number; segments: Array<{ file: string; count: number }> };
const decompress = promisify(gunzip);

/** Disposable spectator cache for committed segments. The recording store remains the owner. */
export class RecordingReader {
  private readonly indexes = new Map<string, { stamp: number; size: number; value: Index }>();
  private readonly segments = new Map<string, { frames: Frame[]; bytes: number }>();
  private readonly loading = new Map<string, Promise<Frame[]>>();
  private bytes = 0;
  constructor(private readonly root: string, private readonly owner: RecordingReadOwner, private readonly maxBytes = 16 * 1024 * 1024) {}

  async get(id: string, frame: number): Promise<Frame> {
    this.requireRetained(id, frame);
    const directory = join(this.root, createHash('sha256').update(id).digest('hex'));
    const path = join(directory, 'index.json');
    let info;
    try { info = await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.owner.get(id, frame); throw error; }
    let index = this.indexes.get(id);
    if (!index || index.stamp !== info.mtimeMs || index.size !== info.size) {
      const value: Index = JSON.parse(await readFile(path, 'utf8'));
      if (value.id !== id || !Array.isArray(value.segments)) throw new Error('Invalid recording index');
      index = { stamp: info.mtimeMs, size: info.size, value };
      this.indexes.delete(id); this.indexes.set(id, index);
      if (this.indexes.size > 64) this.indexes.delete(this.indexes.keys().next().value!);
    }
    let offset = frame - (index.value.firstFrame ?? 0);
    if (offset < 0) throw new Error('Recorded frame not found');
    for (const segment of index.value.segments) {
      if (!Number.isSafeInteger(segment.count) || segment.count < 1 || !/^\d+\.json\.gz$/.test(segment.file)) throw new Error('Invalid recording segment');
      if (offset < segment.count) {
        const frames = await this.segment(join(directory, segment.file));
        this.requireRetained(id, frame); // Collection/reset may have happened during the read.
        const result = frames[offset];
        if (!result || result.world.id !== id) throw new Error('Invalid recorded frame');
        return result;
      }
      offset -= segment.count;
    }
    // Frames still being recorded belong to the owner's queue, not the disk cache.
    return this.owner.get(id, frame);
  }
  private requireRetained(id: string, frame: number) {
    const world = this.owner.list().worlds.find(world => world.id === id);
    if (!world || !Number.isSafeInteger(frame) || frame < world.firstFrame || frame >= world.firstFrame + world.frames) throw new Error('Recorded frame not found');
  }
  private async segment(path: string): Promise<Frame[]> {
    const cached = this.segments.get(path);
    if (cached) { this.segments.delete(path); this.segments.set(path, cached); return cached.frames; }
    let pending = this.loading.get(path);
    if (!pending) {
      pending = (async () => {
        const decoded = await decompress(await readFile(path));
        const frames = JSON.parse(decoded.toString()) as Frame[];
        if (!Array.isArray(frames)) throw new Error('Invalid recording segment');
        // Approximate decoded string storage conservatively, with a fixed upper bound.
        const bytes = decoded.length * 2;
        if (bytes <= this.maxBytes) {
          this.segments.set(path, { frames, bytes }); this.bytes += bytes;
          while (this.bytes > this.maxBytes) {
            const key = this.segments.keys().next().value!;
            this.bytes -= this.segments.get(key)!.bytes; this.segments.delete(key);
          }
        }
        return frames;
      })().finally(() => this.loading.delete(path));
      this.loading.set(path, pending);
    }
    return pending;
  }
}
