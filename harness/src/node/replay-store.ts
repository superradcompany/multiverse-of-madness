import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ReplayPath } from '../replay.ts';
export interface ReplayWorld { id: string; label: string; parentId?: string }
export interface ReplayLayout<World> {
  position(world: World): number;
  legacyForkPosition?(world: World): number | undefined;
  framesPerSegment: number;
}

const compress = promisify(gzip), decompress = promisify(gunzip);
export type RecordedFrame<World> = { world: World; at: number; frame: string };
type Segment = { file: string; count: number; bytes: number };
type Index = { id: string; label: string; parentId?: string; startTick?: number; selected?: boolean; firstFrame?: number; nextSegment?: number; segments: Segment[]; ticks: number[]; times: number[] };
type Entry<World> = { index: Index; pending: RecordedFrame<World>[] };

// Each segment contains genuine frames and matching engine observations, not
// executable snapshots. The adapter chooses the flush size; unflushed frames
// can be lost on crash. The historical on-disk field "ticks" is an opaque
// monotonic game cursor; no tick rate or temporal unit is assumed here.
export class ReplayStore<World extends ReplayWorld> {
  private worlds = new Map<string, Entry<World>>();
  private bytes = 0;
  private chain = Promise.resolve();
  error?: string;
  private protectedIds = new Set<string>();
  private collected = 0;
  constructor(private root: string, private readonly layout: ReplayLayout<World>, private limit = 1024 ** 3,
    private retention = { maxAgeMs: 24 * 60 * 60 * 1000, maxWorlds: 200 }) {
    if (!Number.isSafeInteger(layout.framesPerSegment) || layout.framesPerSegment < 1) throw new Error('Invalid replay segment size');
  }
  protect(ids: string[]) {
    // Prefer retaining the played ancestry over unrelated discarded futures.
    const retained = new Set(ids);
    for (const id of ids) {
      let parent = this.worlds.get(id)?.index.parentId;
      while (parent && !retained.has(parent)) { retained.add(parent); parent = this.worlds.get(parent)?.index.parentId; }
    }
    this.protectedIds = retained;
  }
  private directory(id: string) { return join(this.root, createHash('sha256').update(id).digest('hex')); }
  async open() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      let index: Index;
      try { index = JSON.parse(await readFile(join(this.root, name, 'index.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await rm(join(this.root, name), { recursive: true, force: true }); continue; } throw error; }
      index.firstFrame ??= 0;
      index.nextSegment ??= Math.max(-1, ...index.segments.map(s => Number(s.file.split('.')[0]))) + 1;
      // Files excluded from an atomically published index are interrupted writes
      // or interrupted cleanup, never part of the retained recording.
      const retained = new Set(['index.json', ...index.segments.map(s => s.file)]);
      for (const file of await readdir(join(this.root, name))) {
        if (!retained.has(file) && /^(?:\d+\.json\.gz(?:\.tmp)?|index\.json\.tmp)$/.test(file)) await rm(join(this.root, name, file), { force: true });
      }
      this.worlds.set(index.id, { index, pending: [] });
      this.bytes += index.segments.reduce((sum, s) => sum + s.bytes, 0);
    }
  }
  async record(world: World, frame: Buffer) {
    return this.enqueue(async () => {
      if (this.error) return;
      const position = this.layout.position(world);
      if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid replay position');
      let entry = this.worlds.get(world.id);
      if (!entry) {
        entry = { index: { id: world.id, label: world.label, parentId: world.parentId, startTick: this.layout.position(world), firstFrame: 0, nextSegment: 0, segments: [], ticks: [], times: [] }, pending: [] };
        this.worlds.set(world.id, entry);
      }
      if (entry.index.ticks.at(-1) === this.layout.position(world)) return;
      if ((entry.index.ticks.at(-1) ?? -1) > position) throw new Error('Replay position moved backwards');
      const at = Date.now();
      entry.pending.push({ world: structuredClone(world), at, frame: frame.toString('base64') });
      entry.index.ticks.push(this.layout.position(world)); entry.index.times.push(at);
      if (entry.pending.length >= this.layout.framesPerSegment) await this.flushEntry(entry);
    });
  }
  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task).catch(error => { this.error = `Recording stopped: ${error instanceof Error ? error.message : 'storage failure'}`; this.discardUncommitted(); });
    return this.chain;
  }
  private discardUncommitted() {
    for (const entry of this.worlds.values()) {
      const committed = entry.index.segments.reduce((sum, segment) => sum + segment.count, 0);
      entry.pending = []; entry.index.ticks.length = committed; entry.index.times.length = committed;
    }
  }
  private async flushEntry(entry: Entry<World>) {
    if (!entry.pending.length) return;
    const body = await compress(JSON.stringify(entry.pending));
    await this.collectInternal(entry.index.selected ? 0 : body.length);
    if (!entry.index.selected && !this.protectedIds.has(entry.index.id) && this.cacheBytes() + body.length > this.limit) {
      this.error = 'Recording storage limit reached. Existing recordings are preserved.';
      this.discardUncommitted();
      return;
    }
    const directory = this.directory(entry.index.id);
    await mkdir(directory, { recursive: true });
    const file = `${entry.index.nextSegment ?? 0}.json.gz`;
    await writeFile(join(directory, `${file}.tmp`), body, { mode: 0o600 });
    await rename(join(directory, `${file}.tmp`), join(directory, file));
    const segment = { file, count: entry.pending.length, bytes: body.length };
    const index = { ...entry.index, nextSegment: (entry.index.nextSegment ?? 0) + 1, segments: [...entry.index.segments, segment] };
    await this.saveIndex(index);
    entry.index = index; entry.pending = []; this.bytes += body.length;
  }
  private async saveIndex(index: Index) {
    const directory = this.directory(index.id);
    await writeFile(join(directory, 'index.json.tmp'), JSON.stringify(index), { mode: 0o600 });
    await rename(join(directory, 'index.json.tmp'), join(directory, 'index.json'));
  }
  async collect() { await this.enqueue(() => this.collectInternal()); }
  private async collectInternal(reserve = 0) {
    const inactive = [...this.worlds.values()].filter(e => !e.index.selected && !this.protectedIds.has(e.index.id) && !e.pending.length)
      .sort((a, b) => (a.index.times.at(-1) ?? 0) - (b.index.times.at(-1) ?? 0));
    for (const entry of inactive) {
      if ([...this.worlds.values()].filter(e => !e.index.selected).length <= this.retention.maxWorlds && (entry.index.times.at(-1) ?? Date.now()) >= Date.now() - this.retention.maxAgeMs) continue;
      const old = entry.index.segments;
      // Publish an empty index before deleting data. A crash cannot resurrect it.
      entry.index = { ...entry.index, firstFrame: (entry.index.firstFrame ?? 0) + entry.index.ticks.length, segments: [], ticks: [], times: [] };
      await this.saveIndex(entry.index);
      for (const segment of old) { await rm(join(this.directory(entry.index.id), segment.file), { force: true }); this.bytes -= segment.bytes; this.collected++; }
      await rm(this.directory(entry.index.id), { recursive: true, force: true });
      this.worlds.delete(entry.index.id);
    }
    while (this.cacheBytes() + reserve > this.limit) {
      // Evict only discarded footage. Active trials must stay complete until
      // selection; selected paths are retained until an explicit restart.
      const entry = [...this.worlds.values()].filter(e => !e.index.selected && !this.protectedIds.has(e.index.id) && e.index.segments.length)
        .sort((a, b) => Number(this.protectedIds.has(a.index.id)) - Number(this.protectedIds.has(b.index.id)) || (a.index.times[0] ?? 0) - (b.index.times[0] ?? 0))[0];
      if (!entry) break;
      const segment = entry.index.segments[0]!;
      const index = { ...entry.index, firstFrame: (entry.index.firstFrame ?? 0) + segment.count,
        segments: entry.index.segments.slice(1), ticks: entry.index.ticks.slice(segment.count), times: entry.index.times.slice(segment.count) };
      // Pending frames are memory-only; never publish them into the disk index.
      await this.saveIndex({ ...index, ticks: index.ticks.slice(0, index.ticks.length - entry.pending.length), times: index.times.slice(0, index.times.length - entry.pending.length) });
      await rm(join(this.directory(index.id), segment.file), { force: true });
      entry.index = index; this.bytes -= segment.bytes; this.collected++;
    }
  }
  async flush() { await this.enqueue(async () => { if (!this.error) for (const e of this.worlds.values()) { if (this.error) break; await this.flushEntry(e); } }); }
  list() { return { error: this.error, bytes: this.bytes, retainedBytes: this.bytes - this.cacheBytes(), limit: this.limit, collectedSegments: this.collected, retentionHours: this.retention.maxAgeMs / 3600000, worlds: [...this.worlds.values()].filter(e => e.index.ticks.length > 0).map(({ index }) => ({ id: index.id, label: index.label, parentId: index.parentId, selected: index.selected ?? false, frames: index.ticks.length, firstFrame: index.firstFrame ?? 0, firstTick: index.ticks[0], lastTick: index.ticks.at(-1) })) }; }
  private cacheBytes() {
    return [...this.worlds.values()].filter(e => !e.index.selected)
      .reduce((total, e) => total + e.index.segments.reduce((sum, segment) => sum + segment.bytes, 0), 0);
  }
  /** Retain and publish selected ancestry, including buffered frames, before acknowledging selection/checkpointing. */
  async retainPath(id: string) {
    const task = this.chain.then(async () => {
      const seen = new Set<string>();
      const retained: Entry<World>[] = [];
      let next: string | undefined = id;
      while (next && !seen.has(next)) {
        seen.add(next);
        const entry = this.worlds.get(next);
        if (!entry) break;
        retained.push(entry);
        if (!entry.index.selected) {
          const committed = entry.index.segments.reduce((sum, segment) => sum + segment.count, 0);
          await mkdir(this.directory(next), { recursive: true });
          await this.saveIndex({ ...entry.index, selected: true, ticks: entry.index.ticks.slice(0, committed), times: entry.index.times.slice(0, committed) });
          entry.index.selected = true;
        }
        next = entry.index.parentId;
      }
      // Every ancestor must be selected before a segment flush invokes GC.
      // Repeated retention also flushes new footage from an already selected
      // world. A write failure rejects the caller's publication barrier; pending
      // frames remain available for retry, and committed prefixes stay intact.
      for (const entry of retained.reverse()) await this.flushEntry(entry);
    });
    this.chain = task.catch(() => {});
    await task;
  }
  /** Clear only this recording store, keeping a newly committed restart root. */
  async clearExcept(id: string) {
    const task = this.chain.then(async () => {
      for (const [worldId, entry] of this.worlds) {
        if (worldId === id) continue;
        await rm(this.directory(worldId), { recursive: true, force: true });
        this.bytes -= entry.index.segments.reduce((sum, segment) => sum + segment.bytes, 0);
        this.worlds.delete(worldId);
      }
      this.error = undefined; this.collected = 0;
      this.protectedIds = new Set([id]);
    });
    this.chain = task.catch(() => {});
    await task;
  }
  /** Join at fork ticks, never at wall-clock selection times. No video copying. */
  async path(endpointId: string, untilTick?: number, single = false): Promise<ReplayPath> {
    const task = this.chain.then(() => this.buildPath(endpointId, untilTick, single));
    this.chain = task.then(() => {}, () => {});
    return task;
  }
  private async buildPath(endpointId: string, untilTick?: number, single = false): Promise<ReplayPath> {
    if (untilTick !== undefined && (!Number.isSafeInteger(untilTick) || untilTick < 0)) throw new Error('Invalid replay endpoint');
    const path: Entry<World>[] = [], seen = new Set<string>();
    let id: string | undefined = endpointId;
    let missingHistory = false;
    while (id) {
      if (seen.has(id)) throw new Error('Recording ancestry contains a cycle');
      seen.add(id);
      const entry = this.worlds.get(id);
      if (!entry) { missingHistory = true; break; }
      path.unshift(entry); id = single ? undefined : entry.index.parentId;
    }
    if (!path.length) throw new Error('Recording not found');
    const starts: number[] = [];
    for (const entry of path) {
      const index = entry.index;
      let start = index.startTick;
      if (start === undefined) {
        if (!(index.firstFrame ?? 0)) start = index.ticks[0];
        else if (index.ticks.length) {
          const record = await this.read(index.id, index.firstFrame!);
          // Older metadata can identify the fork point only if the retained
          // frame was still an experiment; a main world's trial is historical.
          start = this.layout.legacyForkPosition?.(record.world);
        }
      }
      if (start === undefined) { missingHistory = true; start = index.ticks[0] ?? 0; }
      starts.push(start);
    }
    const result: ReplayPath = { endpointId, segments: [], frames: 0, firstTick: 0, lastTick: 0, missingHistory };
    for (const [i, entry] of path.entries()) {
      const index = entry.index;
      const end = Math.min(untilTick ?? Infinity, starts[i + 1] ?? Infinity);
      // The parent owns the shared checkpoint frame. The child's first new
      // tick follows it; if the parent's frame expired, keep the child's copy.
      const lower = result.frames ? result.lastTick : -Infinity;
      const first = index.ticks.findIndex(tick => tick >= starts[i]! && tick > lower);
      if (first < 0 || index.ticks[first]! > end) {
        if (starts[i]! < end && (!index.ticks.length || index.ticks[0]! > end)) result.missingHistory = true;
        continue;
      }
      let last = first;
      while (last < index.ticks.length && index.ticks[last]! <= end) last++;
      const ticks = index.ticks.slice(first, last);
      if ((index.firstFrame ?? 0) > 0 && first === 0 && index.ticks[first]! > starts[i]!) result.missingHistory = true;
      if (index.ticks[first]! > starts[i]! && (!result.frames || result.lastTick < starts[i]!)) result.missingHistory = true;
      if (i + 1 < path.length && end === starts[i + 1] && ticks.at(-1)! < end) result.missingHistory = true;
      result.segments.push({ worldId: index.id, label: index.label, firstFrame: (index.firstFrame ?? 0) + first, ticks });
      result.frames += ticks.length;
      if (result.frames === ticks.length) result.firstTick = ticks[0]!;
      result.lastTick = ticks.at(-1)!;
    }
    return result;
  }
  async get(id: string, frameIndex: number): Promise<RecordedFrame<World>> {
    const result = this.chain.then(() => this.read(id, frameIndex));
    this.chain = result.then(() => {}, () => {});
    return result;
  }
  private async read(id: string, frameIndex: number): Promise<RecordedFrame<World>> {
    const entry = this.worlds.get(id);
    if (!entry || !Number.isSafeInteger(frameIndex) || frameIndex < (entry.index.firstFrame ?? 0) || frameIndex >= (entry.index.firstFrame ?? 0) + entry.index.ticks.length) throw new Error('Recorded frame not found');
    let remaining = frameIndex - (entry.index.firstFrame ?? 0);
    for (const segment of entry.index.segments) {
      if (remaining < segment.count) {
        const data = JSON.parse((await decompress(await readFile(join(this.directory(id), segment.file)))).toString()) as RecordedFrame<World>[];
        return data[remaining]!;
      }
      remaining -= segment.count;
    }
    return entry.pending[remaining]!;
  }
}
