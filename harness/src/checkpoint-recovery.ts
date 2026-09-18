import { SerialQueue } from './execution.ts';
import type { RuntimeIdentity, RuntimeWorld, WorldLifecycle } from './world-lifecycle.ts';

export interface CheckpointRecord { id: string; reference: string; createdAt: number }
export interface CheckpointJournal<Point extends CheckpointRecord> {
  points: Point[];
  cleanup: string[];
  pendingCapture?: string;
  pendingRestore?: { id: string; pointId: string };
}
export interface ExecutionCheckpoints<Runtime> {
  capture(runtime: Runtime, reference: string): Promise<void>;
  restore(reference: string, id: string): Promise<Runtime>;
  remove(reference: string): Promise<void>;
  collect?(references: string[]): Promise<string[]>;
}
export interface CheckpointRecoveryPorts<Point extends CheckpointRecord, World, Runtime> {
  journal(): CheckpointJournal<Point>;
  adapter(): ExecutionCheckpoints<Runtime>;
  /** Called with a quiescent source; capture only adapter-owned serializable data. */
  point(world: World): Point;
  /** Must validate exact restored state before returning a registrable world. */
  attach(runtime: Runtime, point: Point): Promise<World>;
  restoreId(): string;
  persist(): Promise<void>;
  retainReplay?(point: Point): Promise<void>;
  stageRestore?(point: Point): () => void;
  /** Resolved and validated once before each capture; in-flight retention stays pinned. */
  limit?: number | (() => number);
}

/** Execution checkpoint transactions; game policy decides when to request them. */
export class CheckpointRecovery<Point extends CheckpointRecord, World extends RuntimeWorld<Runtime>, Runtime extends RuntimeIdentity> {
  private readonly execution = new SerialQueue();
  private readonly readLimit: () => number;
  constructor(private readonly worlds: WorldLifecycle<World, Runtime>, private readonly ports: CheckpointRecoveryPorts<Point, World, Runtime>) {
    const limit = ports.limit ?? 3;
    this.readLimit = typeof limit === 'function' ? limit : () => limit;
    if (typeof limit !== 'function') this.retentionLimit();
  }
  private retentionLimit(): number {
    const limit = this.readLimit();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid checkpoint retention limit');
    return limit;
  }
  get busy(): boolean { return this.execution.busy; }
  async join(): Promise<void> { await this.execution.join(); }

  async capture(signal?: AbortSignal): Promise<Point> {
    let captured!: Point;
    await this.execution.run(async () => {
      this.requireReconciled();
      signal?.throwIfAborted();
      const limit = this.retentionLimit();
      const source = this.worlds.world(this.worlds.mainId);
      if (!source.runtime) throw new Error('Main world has no execution runtime');
      const adapter = this.ports.adapter();
      const point = structuredClone(this.ports.point(source));
      if (!point.id || !point.reference || !Number.isFinite(point.createdAt)) throw new Error('Invalid checkpoint identity');
      const journal = this.ports.journal();
      if (journal.cleanup.includes(point.reference) || journal.points.some(existing => existing.id === point.id || existing.reference === point.reference)) throw new Error('Checkpoint identity already exists');
      journal.pendingCapture = point.reference;
      await this.ports.persist();
      // Once capture is dispatched, finish or leave its journal for reconciliation.
      await adapter.capture(source.runtime, point.reference);
      const old = { points: journal.points, cleanup: journal.cleanup };
      const points = [...journal.points, point], overflow = Math.max(0, points.length - limit);
      journal.points = points.slice(overflow);
      journal.cleanup = [...journal.cleanup, ...points.slice(0, overflow).map(entry => entry.reference)];
      journal.pendingCapture = undefined;
      try {
        await this.ports.retainReplay?.(point);
        await this.ports.persist();
      } catch (error) { Object.assign(journal, old); journal.pendingCapture = point.reference; throw error; }
      await this.collectNow();
      captured = point;
    });
    return captured;
  }

  restore(pointId: string, signal?: AbortSignal): Promise<void> {
    return this.execution.run(async () => {
      await this.worlds.join();
      this.requireReconciled();
      signal?.throwIfAborted();
      const journal = this.ports.journal();
      const point = this.point(pointId);
      const adapter = this.ports.adapter();
      const id = this.ports.restoreId();
      if (!id || this.worlds.worlds.has(id)) throw new Error('Restore requires a new world identity');
      journal.pendingRestore = { id, pointId };
      await this.ports.persist();
      const runtime = await adapter.restore(point.reference, id);
      // Cancellation after dispatch still installs the recoverable, paused result.
      await this.install(runtime, pointId);
    });
  }

  /** Reattach a runtime from a pending restore after process recovery. */
  recover(runtime: Runtime, pointId: string): Promise<void> {
    return this.execution.run(() => this.install(runtime, pointId));
  }
  /** A captured artifact with no committed point must be collected, not adopted. */
  reconcileCapture(): void {
    if (this.busy) throw new Error('Checkpoint operation is in progress');
    const journal = this.ports.journal();
    if (journal.pendingCapture) {
      journal.cleanup.push(journal.pendingCapture);
      journal.pendingCapture = undefined;
    }
  }
  remove(pointId: string): Promise<void> {
    return this.execution.run(async () => {
      this.requireReconciled();
      const journal = this.ports.journal(), point = this.point(pointId);
      const old = { points: journal.points, cleanup: journal.cleanup };
      journal.points = journal.points.filter(existing => existing.id !== pointId);
      journal.cleanup = [...journal.cleanup, point.reference];
      try { await this.ports.persist(); }
      catch (error) { Object.assign(journal, old); throw error; }
      await this.collectNow();
    });
  }
  /** Collectors share the transaction queue so they cannot observe staged pruning. */
  collect(signal?: AbortSignal): Promise<void> { return this.execution.run(() => this.collectNow(signal)); }
  private async collectNow(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const journal = this.ports.journal();
    if (!journal.cleanup.length) return;
    const adapter = this.ports.adapter(), requested = [...journal.cleanup];
    if (requested.some(reference => journal.points.some(point => point.reference === reference))) throw new Error('Checkpoint cleanup refers to a retained checkpoint');
    if (adapter.collect) {
      const removed = new Set(await adapter.collect(requested));
      if ([...removed].some(reference => !requested.includes(reference))) throw new Error('Checkpoint collector returned an unrequested reference');
      journal.cleanup = journal.cleanup.filter(reference => !removed.has(reference));
      await this.ports.persist();
    } else {
      for (const reference of requested) {
        if (signal?.aborted) break;
        await adapter.remove(reference);
        journal.cleanup = journal.cleanup.filter(entry => entry !== reference);
        await this.ports.persist();
      }
    }
  }

  private async install(runtime: Runtime, pointId: string): Promise<void> {
    const journal = this.ports.journal(), point = this.point(pointId);
    if (!journal.pendingRestore || journal.pendingRestore.id !== runtime.id || journal.pendingRestore.pointId !== pointId) throw new Error('Restored runtime does not match the checkpoint journal');
    const existing = this.worlds.worlds.get(runtime.id);
    if (existing && existing.runtime?.identity !== runtime.identity) throw new Error('Restored runtime identity was replaced');
    const attached = await this.ports.attach(runtime, structuredClone(point));
    if (attached.runtime?.id !== runtime.id || attached.runtime.identity !== runtime.identity) throw new Error('Attached world does not own the restored runtime');
    if (existing) this.worlds.replace(new Map([...this.worlds.worlds, [runtime.id, attached]]));
    else this.worlds.register(attached);
    await this.worlds.promote(runtime.id, { stage: () => {
      const old = { pendingRestore: journal.pendingRestore, points: journal.points, cleanup: journal.cleanup };
      const index = journal.points.findIndex(entry => entry.id === pointId);
      journal.cleanup = [...journal.cleanup, ...journal.points.slice(index + 1).map(entry => entry.reference)];
      journal.points = journal.points.slice(0, index + 1);
      journal.pendingRestore = undefined;
      let undo: (() => void) | undefined;
      try { undo = this.ports.stageRestore?.(point); }
      catch (error) { Object.assign(journal, old); throw error; }
      return () => { Object.assign(journal, old); undo?.(); };
    } });
    await this.collectNow();
  }
  private point(id: string): Point {
    const point = this.ports.journal().points.find(candidate => candidate.id === id);
    if (!point) throw new Error('Checkpoint is unavailable');
    return point;
  }
  private requireReconciled(): void {
    const journal = this.ports.journal();
    if (journal.pendingCapture || journal.pendingRestore) throw new Error('Reconcile the interrupted checkpoint operation first');
  }
}
