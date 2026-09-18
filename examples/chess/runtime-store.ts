import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_POSITION } from 'chess.js';
import { SerialQueue, canonicalJson, type RuntimeProvider, type ExecutionCheckpoints, type WorldRuntime } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { ChessWorld, type ChessState, type ChessSave } from './runtime.ts';

interface StoredWorld { version: 1; id: string; identity: string; state: ChessState }
/** Host-owned execution accounting. Wraps the actual input and durable acknowledgment, including forked worlds. */
export interface ChessStepAccounting { run(worldId: string, apply: () => Promise<ChessState>): Promise<ChessState> }
/** A durable board-game runtime, independent of the UI and host process lifetime. */
export class ChessRuntimeStore implements RuntimeProvider<ChessState, { san: string }, string> {
  readonly version = { id: 'chess-file-runtime', version: '1' };
  readonly capabilities = { observations: 'structured', exactFork: true, checkpoint: true, restore: true, detached: true, render: true } as const;
  constructor(private readonly root: string, private readonly initialFen = DEFAULT_POSITION, private readonly accounting?: ChessStepAccounting) {}
  executeStep(worldId: string, apply: () => Promise<ChessState>) { return this.accounting ? this.accounting.run(worldId, apply) : apply(); }
  async create(id: string, signal: AbortSignal): Promise<StoredChessWorld> { signal.throwIfAborted(); return this.createFrom(id, { initialFen: this.initialFen, moves: [] }); }
  async createFrom(id: string, saved: ChessSave): Promise<StoredChessWorld> {
    if (!id.trim()) throw new Error('World id must not be empty');
    const world = new ChessWorld(id, saved), record: StoredWorld = { version: 1, id, identity: world.identity, state: await world.state() };
    const path = this.worldPath(id); await mkdir(join(this.root, 'worlds'), { recursive: true });
    await writeFile(path, canonicalJson(record), { flag: 'wx', mode: 0o600 });
    return new StoredChessWorld(this, world, new JsonFileStore(path, decode));
  }
  async connect(id: string, identity: string, signal: AbortSignal): Promise<StoredChessWorld> {
    signal.throwIfAborted();
    const path = this.worldPath(id), store = new JsonFileStore(path, decode), record = await store.load();
    if (!record || record.id !== id || record.identity !== identity) throw new Error('Chess runtime missing or replaced');
    const world = new ChessWorld(id, record.state, identity);
    if (canonicalJson(await world.state()) !== canonicalJson(record.state)) throw new Error('Saved chess history does not match observed state');
    return new StoredChessWorld(this, world, store);
  }
  async recover(id: string): Promise<StoredChessWorld | undefined> {
    const record = await new JsonFileStore(this.worldPath(id), decode).load();
    return record ? this.connect(id, record.identity, new AbortController().signal) : undefined;
  }
  async destroy(id: string, identity: string): Promise<void> {
    const record = await new JsonFileStore(this.worldPath(id), decode).load();
    if (!record) return;
    if (record.id !== id || record.identity !== identity) throw new Error('Refusing to remove a replaced chess runtime');
    await rm(this.worldPath(id));
  }
  checkpoints(): ExecutionCheckpoints<StoredChessWorld> {
    return { capture: (world, reference) => world.captureCheckpoint(reference), restore: (reference, id) => this.restore(reference, id, new AbortController().signal), remove: reference => this.removeCheckpoint(reference) };
  }
  async capture(state: ChessState, reference: string): Promise<void> {
    await mkdir(join(this.root, 'checkpoints'), { recursive: true });
    await writeFile(this.pointPath(reference), canonicalJson({ version: 1, reference, state }), { flag: 'wx', mode: 0o600 });
  }
  async restore(reference: string, id: string, signal: AbortSignal): Promise<StoredChessWorld> {
    signal.throwIfAborted();
    const saved = JSON.parse(await readFile(this.pointPath(reference), 'utf8')) as { version: number; reference: string; state: ChessState };
    if (saved.version !== 1 || saved.reference !== reference) throw new Error('Invalid chess execution checkpoint');
    const probe = new ChessWorld('validate', saved.state);
    if (canonicalJson(await probe.state()) !== canonicalJson(saved.state)) throw new Error('Checkpoint chess history does not match state');
    return this.createFrom(id, saved.state);
  }
  async removeCheckpoint(reference: string): Promise<void> { await rm(this.pointPath(reference), { force: true }); }
  private worldPath(id: string) { return join(this.root, 'worlds', `${hash(id)}.json`); }
  private pointPath(reference: string) { return join(this.root, 'checkpoints', `${hash(reference)}.json`); }
}

/** Host owns one handle at a time; storage ownership must be exclusive across processes. */
export class StoredChessWorld implements WorldRuntime<ChessState, { san: string }, string> {
  private readonly queue = new SerialQueue();
  private poisoned = false;
  constructor(private readonly provider: ChessRuntimeStore, private readonly world: ChessWorld, private readonly store: JsonFileStore<StoredWorld>) {}
  get id(): string { return this.world.id; }
  get identity(): string { return this.world.identity; }
  state(): Promise<ChessState> { return this.queue.run(() => { this.check(); return this.world.state(); }); }
  frame(): Promise<string> { return this.queue.run(() => { this.check(); return this.world.frame(); }); }
  step(command: { san: string }): Promise<ChessState> {
    return this.queue.run(async () => {
      this.check();
      return this.provider.executeStep(this.id, async () => {
        const state = await this.world.step(command);
        try { await this.store.save({ version: 1, id: this.id, identity: this.identity, state }); }
        catch (error) { this.poisoned = true; throw error; }
        return state;
      });
    });
  }
  branch(ids: string[]): Promise<StoredChessWorld[]> {
    return this.queue.run(async () => {
      this.check();
      if (new Set(ids).size !== ids.length || ids.some(id => !id.trim() || id === this.id)) throw new Error('Invalid child world identities');
      const state = await this.world.state(), children: StoredChessWorld[] = [];
      try { for (const id of ids) children.push(await this.provider.createFrom(id, state)); return children; }
      catch (error) {
        const cleanup = await Promise.allSettled(children.map(child => child.destroy()));
        const failures = cleanup.flatMap(item => item.status === 'rejected' ? [item.reason] : []);
        if (failures.length) throw new AggregateError([error, ...failures], 'Partial chess fork and cleanup failed');
        throw error;
      }
    });
  }
  captureCheckpoint(reference: string): Promise<void> { return this.queue.run(async () => { this.check(); await this.provider.capture(await this.world.state(), reference); }); }
  destroy(): Promise<void> { return this.queue.run(async () => { await this.provider.destroy(this.id, this.identity); await this.world.destroy(); }); }
  private check() { if (this.poisoned) throw new Error('Chess runtime persistence failed; reconnect from authoritative storage'); }
}
function hash(id: string): string { return createHash('sha256').update(id).digest('hex'); }
function decode(value: unknown): StoredWorld {
  const record = value as StoredWorld;
  if (!record || record.version !== 1 || !record.id?.trim() || !record.identity?.trim() || !record.state || !Array.isArray(record.state.moves)) throw new Error('Invalid chess runtime record');
  return record;
}
