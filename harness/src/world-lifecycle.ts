import { ExecutionGate } from './execution.ts';

export interface RuntimeIdentity { readonly id: string; readonly identity: string; destroy(): Promise<void> }
export interface RuntimeReference { id: string; identity: string }
export interface RuntimeWorld<Runtime extends RuntimeIdentity> { runtime?: Runtime }
export interface WorldMetadata {
  id: string;
  role: 'main' | 'experiment' | 'archived';
  status: 'running' | 'paused' | 'ended';
  controller: 'ai' | 'human';
}
export interface PromotionOptions {
  signal?: AbortSignal;
  /** Return after durable selection; join before admitting more runtimes or handing off ownership. */
  cleanup?: 'wait' | 'background';
  /** Additional journal/domain changes committed with the winning world. */
  stage?: () => () => void;
}
export interface WorldLifecyclePorts<World> {
  /** Mutable neutral metadata; game observations remain opaque to the lifecycle. */
  metadata(world: World): WorldMetadata;
  persist(): Promise<void>;
  retainReplay?(id: string): Promise<void>;
  /** Stage application metadata before publication; return its rollback operation. */
  stageSelection?(id: string): () => void;
  archivedWorldLimit?: number;
}

/** Registry and durable transitions shared by every game adapter. */
export class WorldLifecycle<World extends RuntimeWorld<Runtime>, Runtime extends RuntimeIdentity> {
  private registry = new Map<string, World>();
  private readonly execution = new ExecutionGate();
  private readonly archivedWorldLimit: number;
  private retirement?: Promise<PromiseSettledResult<RuntimeReference>[]>;
  private retirementJoin?: Promise<void>;
  mainId = '';
  cleanup: RuntimeReference[] = [];
  constructor(private readonly ports: WorldLifecyclePorts<World>) {
    this.archivedWorldLimit = ports.archivedWorldLimit ?? 20;
    if (!Number.isSafeInteger(this.archivedWorldLimit) || this.archivedWorldLimit < 0) throw new Error('Invalid archived world limit');
  }
  get worlds(): ReadonlyMap<string, World> { return this.registry; }
  get busy(): boolean { return this.execution.busy || this.retirement !== undefined; }
  async join(): Promise<void> {
    await this.execution.join();
    if (!this.retirement) return;
    // Concurrent pause/admission callers share the same journal settlement.
    this.retirementJoin ??= this.execution.run(() => this.settleRetirement()).finally(() => { this.retirementJoin = undefined; });
    await this.retirementJoin;
  }
  world(id: string): World {
    const world = this.registry.get(id);
    if (!world) throw new Error(`Unknown world: ${id}`);
    return world;
  }
  register(world: World): void {
    this.requireIdle();
    const id = this.ports.metadata(world).id;
    this.validateWorld(id, world);
    if (this.registry.has(id)) throw new Error(`World already registered: ${id}`);
    if (world.runtime && [...this.registry.values()].some(existing => existing.runtime?.identity === world.runtime!.identity)) throw new Error('Runtime identity is already owned by another world');
    this.registry.set(id, world);
  }
  /** Import a prepared registry at an idle restore/restart boundary. */
  replace(worlds: ReadonlyMap<string, World>): void {
    this.requireIdle();
    const identities = new Set<string>();
    for (const [id, world] of worlds) {
      this.validateWorld(id, world);
      if (world.runtime) {
        if (identities.has(world.runtime.identity)) throw new Error('Runtime identity is already owned by another world');
        identities.add(world.runtime.identity);
      }
    }
    this.registry = new Map(worlds);
  }

  /** Persist selection and cleanup intent before releasing any superseded runtime. */
  promote(id: string, options: PromotionOptions = {}): Promise<void> {
    const { signal, stage } = options;
    if (this.retirement) throw new Error('Join previous world cleanup before promoting another world');
    return this.execution.run(async () => {
      signal?.throwIfAborted();
      const winner = this.world(id);
      const selected = this.ports.metadata(winner);
      if (selected.role === 'archived' || !winner.runtime) throw new Error('Select a world with an active runtime');
      const before = [...this.registry.values()].map(world => {
        const metadata = this.ports.metadata(world);
        return { world, runtime: world.runtime, role: metadata.role, status: metadata.status, controller: metadata.controller };
      });
      const oldMain = this.mainId, oldCleanup = [...this.cleanup];
      const retired: Runtime[] = [];
      const undo: Array<() => void> = [];
      try {
        await this.ports.retainReplay?.(id);
        signal?.throwIfAborted();
        for (const world of this.registry.values()) {
          const metadata = this.ports.metadata(world);
          if (world === winner || metadata.role === 'archived') continue;
          if (world.runtime) {
            retired.push(world.runtime);
            const reference = { id: world.runtime.id, identity: world.runtime.identity };
            if (!this.cleanup.some(entry => sameRuntime(entry, reference))) this.cleanup.push(reference);
          }
          world.runtime = undefined;
          metadata.role = 'archived'; metadata.status = 'ended'; metadata.controller = 'ai';
        }
        selected.role = 'main'; selected.status = 'paused';
        this.mainId = id;
        const undoSelection = this.ports.stageSelection?.(id);
        if (undoSelection) undo.push(undoSelection);
        if (stage) undo.push(stage());
        await this.ports.persist();
      } catch (error) {
        // No destroy has been dispatched. Keep every source and child usable.
        this.mainId = oldMain; this.cleanup = oldCleanup;
        for (const entry of before) {
          entry.world.runtime = entry.runtime;
          Object.assign(this.ports.metadata(entry.world), { role: entry.role, status: entry.status, controller: entry.controller });
        }
        for (const rollback of undo.reverse()) rollback();
        throw error;
      }
      // No background task mutates the registry or journal. Until join, the
      // durable cleanup intent remains sufficient for crash recovery.
      this.retirement = Promise.allSettled(retired.map(async runtime => {
        await runtime.destroy();
        return { id: runtime.id, identity: runtime.identity };
      }));
      if (options.cleanup !== 'background') await this.settleRetirement();
    });
  }

  /** Retry only journaled identities. The adapter also checks identity before deletion. */
  collect(destroy: (id: string, identity: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
    return this.execution.run(async () => {
      // Collect retries failed identities itself after joining dispatched work.
      await this.settleRetirement(false);
      for (const entry of [...this.cleanup]) {
        if (signal?.aborted) break;
        if ([...this.registry.values()].some(world => world.runtime && (world.runtime.id === entry.id || world.runtime.identity === entry.identity))) {
          throw new Error(`Cleanup journal refers to an active runtime: ${entry.id}`);
        }
        await destroy(entry.id, entry.identity);
        this.cleanup = this.cleanup.filter(item => !sameRuntime(item, entry));
        await this.ports.persist();
      }
    });
  }
  private async settleRetirement(reportFailure = true): Promise<void> {
    if (!this.retirement) return;
    const released = await this.retirement;
    for (const result of released) {
      if (result.status === 'fulfilled') this.cleanup = this.cleanup.filter(entry => !sameRuntime(entry, result.value));
    }
    const archived = [...this.registry.values()].filter(world => this.ports.metadata(world).role === 'archived');
    for (const world of archived.slice(0, Math.max(0, archived.length - this.archivedWorldLimit))) this.registry.delete(this.ports.metadata(world).id);
    await this.ports.persist();
    this.retirement = undefined;
    const failed = released.find(result => result.status === 'rejected');
    if (reportFailure && failed?.status === 'rejected') throw failed.reason;
  }
  private requireIdle(): void { if (this.busy) throw new Error('World lifecycle operation is in progress'); }
  private validateWorld(id: string, world: World): void {
    if (!id || this.ports.metadata(world).id !== id) throw new Error('World registry identity mismatch');
    if (world.runtime && (world.runtime.id !== id || !world.runtime.identity)) throw new Error('World runtime identity mismatch');
  }
}
function sameRuntime(a: RuntimeReference, b: RuntimeReference): boolean { return a.id === b.id && a.identity === b.identity; }
