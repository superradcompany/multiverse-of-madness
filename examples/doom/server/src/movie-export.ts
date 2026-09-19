import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { ReplayPath } from '../../contracts/src/replay.ts';
import type { Recordings } from './recordings.ts';

const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
const ffmpegPath = typeof binary === 'string' ? binary : null;

export interface MovieExportView {
  id: string;
  status: 'encoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  missingHistory: boolean;
  error?: string;
  bytes?: number;
}
type Job = { view: MovieExportView; file: string; updated: number; controller: AbortController; task: Promise<void> };

/** Local, bounded export jobs. MP4s are temporary; source recordings are untouched. */
export class MovieExports {
  private jobs = new Map<string, Job>();
  private timer?: ReturnType<typeof setInterval>;
  private starting = false;
  constructor(private recordings: Pick<Recordings, 'path' | 'get'>, private directory: string) {}
  async open() {
    await mkdir(this.directory, { recursive: true });
    // This directory contains only disposable exports, including interrupted jobs.
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.mp4$/.test(file)) await rm(join(this.directory, file), { force: true });
    this.timer = setInterval(() => { void this.collect().catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  async start(worldId: string, untilTick: number, single = false, allowPartial = false) {
    if (this.starting || [...this.jobs.values()].some(j => j.view.status === 'encoding')) throw new Error('Another movie is being exported. Wait or cancel it first.');
    this.starting = true;
    try {
      const path = await this.recordings.path(worldId, untilTick, single);
      if (!path.frames) throw new Error('No recorded frames to export.');
      if (path.missingHistory && !allowPartial) throw new Error('Earlier footage is missing. Export available footage instead.');
      if (!ffmpegPath) throw new Error('MP4 export is unavailable on this platform.');
      const id = randomUUID();
      const job: Job = { view: { id, status: 'encoding', progress: 0, missingHistory: path.missingHistory }, file: join(this.directory, `${id}.mp4`), updated: Date.now(), controller: new AbortController(), task: Promise.resolve() };
      this.jobs.set(id, job);
      job.task = this.encode(job, path).catch(async error => {
        // Publish the terminal state only after incomplete output is removed.
        // Polling clients may act on that state immediately.
        try { await rm(job.file, { force: true }); }
        catch {
          job.view.status = 'error';
          job.view.error = 'Movie export failed and its temporary file could not be removed. Retry cancellation to clean it up.';
          return;
        }
        job.view.status = job.controller.signal.aborted ? 'cancelled' : 'error';
        job.view.error = job.controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Movie export failed.';
      }).finally(() => { job.updated = Date.now(); });
      void job.task.catch(() => {});
      return { ...job.view };
    } finally { this.starting = false; }
  }
  private async encode(job: Job, path: ReplayPath) {
    const signal = job.controller.signal;
    const encoder = spawn(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '35', '-vcodec', 'png', '-i', 'pipe:0', '-an', '-vf', 'scale=960:-2:flags=neighbor', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', job.file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostic = '';
    encoder.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
    encoder.stdin.on('error', () => {});
    const finished = new Promise<void>((resolve, reject) => {
      encoder.once('error', () => reject(new Error('Could not start the MP4 encoder. Reinstall ffmpeg-static.')));
      encoder.once('close', code => code === 0 ? resolve() : reject(new Error(`MP4 encoding failed${diagnostic ? ': ' + diagnostic.trim() : ''}`)));
    });
    void finished.catch(() => {});
    const cancel = () => { encoder.kill('SIGKILL'); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const points = path.segments.flatMap(s => s.ticks.map((tick, offset) => ({ worldId: s.worldId, frame: s.firstFrame + offset, tick })));
      const durationTicks = path.lastTick - path.firstTick + 1;
      for (const [index, point] of points.entries()) {
        signal.throwIfAborted();
        const record = await this.recordings.get(point.worldId, point.frame);
        const png = Buffer.from(record.frame, 'base64');
        // Hold sparse legacy frames for their actual game-time duration. Fork
        // boundaries come from the same ancestry path used by the replay UI.
        const repeats = (points[index + 1]?.tick ?? point.tick + 1) - point.tick;
        for (let tick = 0; tick < repeats; tick++) {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => encoder.stdin.write(png, error => error ? reject(error) : resolve()));
        }
        job.view.progress = Math.min(99, Math.floor((point.tick - path.firstTick + repeats) / durationTicks * 100));
      }
      encoder.stdin.end();
      await finished;
      signal.throwIfAborted();
      job.view.bytes = (await stat(job.file)).size;
      job.view.status = 'ready'; job.view.progress = 100;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (encoder.exitCode === null) encoder.kill('SIGKILL');
      await finished.catch(() => {});
    }
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Export expired or was not found. Export the recording again.');
    job.updated = Date.now();
    return { ...job.view };
  }
  file(id: string) {
    if (this.get(id).status !== 'ready') throw new Error('Movie is not ready yet.');
    return this.jobs.get(id)!.file;
  }
  async cancel(id: string) {
    this.get(id);
    const job = this.jobs.get(id)!;
    job.controller.abort(); await job.task;
    await rm(job.file, { force: true });
    job.view.status = 'cancelled'; job.updated = Date.now();
  }
  private async collect() {
    for (const [id, job] of this.jobs) if (job.view.status !== 'encoding' && Date.now() - job.updated > 30 * 60_000) {
      await rm(job.file, { force: true }); this.jobs.delete(id);
    }
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
  }
}
