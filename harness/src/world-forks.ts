import { ExecutionGate } from './execution.ts';
import type { RuntimeIdentity, RuntimeReference, RuntimeWorld, WorldLifecycle } from './world-lifecycle.ts';

export interface ForkIntent {
  parentId: string;
  parentIdentity?: string;
  ids: string[];
  /** Physical identities become known after the provider acknowledges creation. */
  created?: RuntimeReference[];
}
export interface WorldForkPorts<Intent extends ForkIntent, World, Runtime> {
  pending(): Intent | undefined;
  setPending(intent: Intent | undefined): void;
  persist(): Promise<void>;
  /** Omit when exact runtime branching is unsupported. The source must be quiescent. */
  fork?(runtime: Runtime, ids: string[]): Promise<Runtime[]>;
  /** Read and validate the child against the captured source before publishing it. */
  attach(runtime: Runtime, source: World, intent: Intent, index: number): Promise<World>;
  /** Apply trial/domain metadata to newly attached children; return synchronous undo. */
  stage?(children: World[], source: World, intent: Intent): () => void;
  retain?(world: World): Promise<void>;
}

/** Durable fork intent, exact identity checks and recovery without replaying creation. */
export class WorldForks<Intent extends ForkIntent, World extends RuntimeWorld<Runtime>, Runtime extends RuntimeIdentity> {
  private readonly execution = new ExecutionGate();
  constructor(private readonly worlds: WorldLifecycle<World, Runtime>, private readonly ports: WorldForkPorts<Intent, World, Runtime>) {}
  get busy(): boolean { return this.execution.busy; }
  join(): Promise<void> { return this.execution.join(); }

  create(intent: Intent, signal?: AbortSignal): Promise<World[]> {
    // Pin domain plans and bounds before asynchronous publication or runtime work.
    const pinned = structuredClone(intent);
    return this.run(async () => {
      await this.worlds.join(); // Bound runtime count before admitting the next batch.
      if (this.worlds.cleanup.length) throw new Error('Reconcile pending world cleanup before creating another batch');
      signal?.throwIfAborted();
      if (this.ports.pending()) throw new Error('Reconcile the interrupted fork before creating another batch');
      this.validate(pinned, false);
      const fork = this.ports.fork?.bind(this.ports);
      if (!fork) throw new Error('Runtime does not support exact branching');
      const source = this.source(pinned), runtime = source.runtime!;
      pinned.parentIdentity = runtime.identity;
      this.ports.setPending(structuredClone(pinned));
      await this.ports.persist();
      if (signal?.aborted) { await this.publishEmpty(pinned); return []; }
      // Once dispatched, settle and retain the intent even on provider failure.
      const children = await fork(runtime, [...pinned.ids]);
      this.validateReturned(children, pinned.ids);
      pinned.created = children.map(child => ({ id: child.id, identity: child.identity }));
      this.ports.setPending(structuredClone(pinned));
      await this.ports.persist();
      return this.install(pinned, source, children);
    });
  }

  /** Missing means definitively absent; the adapter must join any pending creation first. */
  reconcile(recover: (id: string) => Promise<Runtime | undefined>, signal?: AbortSignal): Promise<World[]> {
    return this.run(async () => {
      signal?.throwIfAborted();
      const intent = this.ports.pending();
      if (!intent) return [];
      const pinned = structuredClone(intent);
      this.validate(pinned, true);
      const source = this.source(pinned);
      const recovered: Runtime[] = [];
      for (const id of pinned.ids) {
        signal?.throwIfAborted();
        const existing = this.worlds.worlds.get(id);
        const runtime = existing?.runtime ?? await recover(id);
        if (!runtime) {
          if (existing) throw new Error(`Registered fork child has no active runtime: ${id}`);
          continue;
        }
        if (runtime.id !== id) throw new Error(`Recovered runtime does not match fork child ${id}`);
        const expected = pinned.created?.find(reference => reference.id === id);
        if (expected && expected.identity !== runtime.identity) throw new Error(`Fork child ${id} was replaced`);
        recovered.push(runtime);
      }
      this.validateReturned(recovered, recovered.map(child => child.id));
      return this.install(pinned, source, recovered);
    });
  }

  private async install(intent: Intent, source: World, runtimes: Runtime[]): Promise<World[]> {
    const children: World[] = [];
    for (const runtime of runtimes) {
      if (this.worlds.worlds.has(runtime.id)) continue; // Legacy journals can contain already-published children.
      const world = await this.ports.attach(runtime, source, structuredClone(intent), intent.ids.indexOf(runtime.id));
      if (world.runtime?.id !== runtime.id || world.runtime.identity !== runtime.identity) throw new Error('Attached fork world does not own its runtime');
      children.push(world);
    }
    if (this.source(intent) !== source) throw new Error('Fork source changed before publication');
    const before = new Map(this.worlds.worlds);
    let undo: (() => void) | undefined;
    try {
      for (const child of children) this.worlds.register(child);
      undo = this.ports.stage?.(children, source, structuredClone(intent));
      for (const child of children) await this.ports.retain?.(child);
      this.ports.setPending(undefined);
      await this.ports.persist();
    } catch (error) {
      undo?.();
      this.worlds.replace(before);
      this.ports.setPending(structuredClone(intent));
      throw error;
    }
    return intent.ids.flatMap(id => this.worlds.worlds.has(id) ? [this.worlds.world(id)] : []);
  }
  private async publishEmpty(intent: Intent): Promise<void> {
    this.ports.setPending(undefined);
    try { await this.ports.persist(); }
    catch (error) { this.ports.setPending(structuredClone(intent)); throw error; }
  }
  private run(work: () => Promise<World[]>): Promise<World[]> {
    let result: World[] = [];
    return this.execution.run(async () => { result = await work(); }).then(() => result);
  }
  private source(intent: Intent): World {
    const source = this.worlds.world(intent.parentId);
    if (!source.runtime) throw new Error('Fork source has no active runtime');
    if (intent.parentIdentity && source.runtime.identity !== intent.parentIdentity) throw new Error('Fork source runtime was replaced');
    return source;
  }
  private validate(intent: Intent, recovering: boolean): void {
    if (!intent.parentId || !intent.ids.length || new Set(intent.ids).size !== intent.ids.length
      || intent.ids.some(id => !id || id === intent.parentId || (!recovering && this.worlds.worlds.has(id)))) throw new Error('Fork requires new unique child identities');
    const created = intent.created ?? [];
    if (new Set(created.map(reference => reference.id)).size !== created.length || new Set(created.map(reference => reference.identity)).size !== created.length
      || created.some(reference => !reference.identity || !intent.ids.includes(reference.id))) throw new Error('Invalid acknowledged fork identities');
    if (!recovering && created.length) throw new Error('A new fork cannot supply pre-existing physical identities');
  }
  private validateReturned(runtimes: Runtime[], ids: string[]): void {
    if (runtimes.length !== ids.length || new Set(runtimes.map(runtime => runtime.id)).size !== ids.length
      || new Set(runtimes.map(runtime => runtime.identity)).size !== ids.length
      || runtimes.some(runtime => !runtime.identity || !ids.includes(runtime.id))) throw new Error('Runtime returned an invalid fork batch');
    for (const runtime of runtimes) {
      const owner = [...this.worlds.worlds.entries()].find(([, world]) => world.runtime?.identity === runtime.identity);
      if (owner && owner[0] !== runtime.id) throw new Error('Fork runtime identity belongs to another world');
    }
  }
}
