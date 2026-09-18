import type { WorldView } from '../../contracts/src/session.ts';

/** Bound queued footage without putting each compression/disk flush on the game clock. */
export class BufferedRecorder {
  private pending = 0;
  constructor(private readonly write: (world: WorldView, frame: Buffer) => Promise<void>, private readonly capacity = 140) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid recording buffer capacity');
  }
  record(world: WorldView, frame: Buffer): Promise<void> {
    // The session mutates its view next tick. Capture matching metadata before queuing.
    const saved = structuredClone(world);
    this.pending++;
    const write = this.write(saved, frame).finally(() => { this.pending--; });
    // Recordings owns its error state and ordered flush/retention. Observe rejection
    // here too, including for an alternate writer supplied by a host/test.
    void write.catch(() => {});
    return this.pending >= this.capacity ? write : Promise.resolve();
  }
}
