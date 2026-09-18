import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type BudgetLedger, type CheckpointStore } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { stepSchema, type Step, type GameState } from '../../../packages/contracts/src/game.ts';
import type { CheckpointAdapter } from './checkpoints.ts';
import type { WorldRuntime } from './runtime.ts';

/** Host-captured incident input. The evaluator borrows this snapshot; its owner retains it until every run is cleaned. */
export const doomIncidentCheckpointSchema = z.strictObject({
  reference: z.string().regex(/^mom-checkpoint-[a-f0-9-]{36}:recovery$/), identity: z.string().min(1),
  state: z.strictObject({ id: z.literal('doom-game-state'), version: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
});
export type DoomIncidentCheckpoint = z.infer<typeof doomIncidentCheckpointSchema>;
export function doomIncidentCheckpoint(reference: string, identity: string, state: GameState): DoomIncidentCheckpoint {
  return doomIncidentCheckpointSchema.parse({ reference, identity, state: contentRevision('doom-game-state', state) });
}

const worldSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,128}$/), identity: z.string().min(1).optional(), restoredFrom: z.string().min(1).optional(), released: z.boolean() });
const pointSchema = z.strictObject({ reference: z.string().regex(/^mom-checkpoint-[a-f0-9-]{36}:recovery$/), identity: z.string().min(1).optional(), released: z.boolean() });
const runSchema = z.strictObject({ id: z.string().min(1).max(512), closed: z.boolean(), worlds: z.array(worldSchema), checkpoints: z.array(pointSchema) });
const schema = z.strictObject({ version: z.literal(1), owner: z.string().uuid(), runs: z.array(runSchema) });
export type SavedDoomEvaluationVms = z.infer<typeof schema>;
type Run = SavedDoomEvaluationVms['runs'][number];
type World = Run['worlds'][number];
export function decodeDoomEvaluationVms(value: unknown): SavedDoomEvaluationVms {
  const saved = schema.parse(value);
  const worldIds = saved.runs.flatMap(run => run.worlds.map(world => world.id));
  const references = saved.runs.flatMap(run => run.checkpoints.map(point => point.reference));
  if (new Set(saved.runs.map(run => run.id)).size !== saved.runs.length || new Set(worldIds).size !== worldIds.length
    || new Set(references).size !== references.length) throw new Error('Duplicate evaluation resource ownership');
  return saved;
}
export interface DoomEvaluationVmPorts {
  /** The factory labels each root with owner/run; forks inherit those labels. */
  create(id: string, owner: string, runId: string): Promise<WorldRuntime>;
  /** Check exact acknowledged identity, or labels/recorded restore provenance for an unacknowledged creation. Missing is success. */
  destroy(id: string, identity: string | undefined, owner: string, runId: string, restoredFrom?: string): Promise<void>;
  capture(world: WorldRuntime, reference: string): Promise<void>;
  restore(reference: string, id: string): Promise<WorldRuntime>;
  /** Read exact source catalog lineage before forking. Restored worlds and their forks may have no labels. */
  parentSnapshot(world: WorldRuntime): Promise<string | undefined>;
  snapshotIdentity(reference: string): Promise<string | undefined>;
  /** Verify acknowledged identities, delete only requested leaves, return references still retained by descendants. */
  collect(points: Array<{ reference: string; identity?: string }>): Promise<string[]>;
}

/** Physical-resource ownership below Session's logical fork/promotion/recovery transactions. */
export class DoomEvaluationVms {
  private writes: Promise<void> = Promise.resolve();
  private failure?: { cause: unknown };
  private readonly work = new Map<string, Set<Promise<unknown>>>();
  private readonly runtimes = new Map<string, WorldRuntime>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly bindings = new Map<string, { ledger: BudgetLedger; signal: AbortSignal }>();
  private constructor(private readonly store: CheckpointStore<SavedDoomEvaluationVms>, private readonly ports: DoomEvaluationVmPorts,
    private readonly saved: SavedDoomEvaluationVms) {}

  /** Caller owns the store exclusively. Opening recovers unfinished resources, never resumes an experiment. */
  static async open(store: CheckpointStore<SavedDoomEvaluationVms>, ports: DoomEvaluationVmPorts): Promise<DoomEvaluationVms> {
    const value = await store.load();
    const saved = value === undefined ? { version: 1 as const, owner: randomUUID(), runs: [] } : decodeDoomEvaluationVms(value);
    const result = new DoomEvaluationVms(store, ports, saved);
    await result.recover(); await result.publish(); return result;
  }
  snapshot(): SavedDoomEvaluationVms { return structuredClone(this.saved); }

  async create(runId: string, ledger: BudgetLedger, signal: AbortSignal, setup: Step[] = [], incident?: DoomIncidentCheckpoint): Promise<WorldRuntime> {
    this.usable(); signal.throwIfAborted(); z.string().min(1).max(512).parse(runId);
    const steps = setup.map(command => stepSchema.parse(command));
    const checkpoint = incident ? doomIncidentCheckpointSchema.parse(incident) : undefined;
    if (this.saved.runs.some(run => run.id === runId)) throw new Error('Evaluation run already owns a resource journal; never repeat it');
    if (this.saved.runs.some(run => !run.closed || run.worlds.some(world => !world.released) || run.checkpoints.some(point => !point.released))) throw new Error('Finish cleanup of the previous evaluation run first');
    const id = 'mom-eval-' + randomUUID().replaceAll('-', '').slice(0, 16);
    const root: World = { id, released: false, ...(checkpoint ? { restoredFrom: checkpoint.identity } : {}) }, run: Run = { id: runId, closed: false, worlds: [root], checkpoints: [] };
    this.saved.runs.push(run); this.bindings.set(runId, { ledger, signal });
    return this.perform(run, async () => {
      await this.publish();
      let world: WorldRuntime;
      if (checkpoint) {
        if (await this.ports.snapshotIdentity(checkpoint.reference) !== checkpoint.identity) throw new Error('Incident checkpoint is missing or was replaced');
        signal.throwIfAborted();
        const runtime = await this.ports.restore(checkpoint.reference, id);
        world = await this.attach(run, root, runtime);
        if (await this.ports.snapshotIdentity(checkpoint.reference) !== checkpoint.identity
          || await this.ports.parentSnapshot(runtime) !== checkpoint.identity
          || canonicalJson(contentRevision('doom-game-state', await runtime.state())) !== canonicalJson(checkpoint.state)) {
          throw new Error('Incident restore does not match the captured game state and identity');
        }
        // Memory restore does not execute inputs. Do not charge the historical
        // tick counter as fresh simulation; every subsequent input is metered.
      } else {
        world = await ledger.run({ owner: runId, operation: 'vm-game-initialization', reserve: { simulation: 35 } }, async () => {
          const runtime = await this.ports.create(id, this.saved.owner, runId);
          const wrapped = await this.attach(run, root, runtime);
          const state = await runtime.state();
          return { value: wrapped, usage: { simulation: state.tick } };
        }, signal);
      }
      for (const command of steps) await world.step(command);
      signal.throwIfAborted(); return world;
    });
  }

  /** Available before create so Session can install its adapter; methods validate the eventual run binding. */
  checkpoints(runId: string): CheckpointAdapter {
    return {
      capture: (world, reference) => {
        const run = this.run(runId), entry = run.worlds.find(item => item.id === world.id && item.identity === world.identity && !item.released);
        if (!entry) return Promise.reject(new Error('Checkpoint source is not owned by this evaluation'));
        return this.perform(run, async () => {
          this.binding(run).signal.throwIfAborted();
          const point = pointSchema.parse({ reference, released: false });
          if (this.saved.runs.some(item => item.checkpoints.some(existing => existing.reference === reference))) throw new Error('Checkpoint already has an owner');
          run.checkpoints.push(point); await this.publish();
          this.binding(run).signal.throwIfAborted();
          await this.ports.capture(this.runtimes.get(entry.id)!, reference);
          point.identity = await this.ports.snapshotIdentity(reference);
          if (!point.identity) throw new Error('Checkpoint capture did not publish its artifact');
          await this.publish();
        });
      },
      restore: (reference, id) => {
        const run = this.run(runId), point = run.checkpoints.find(item => item.reference === reference && !item.released);
        if (!point?.identity) return Promise.reject(new Error('Cannot restore an unacknowledged or unowned checkpoint'));
        return this.perform(run, async () => {
          this.binding(run).signal.throwIfAborted();
          if (await this.ports.snapshotIdentity(reference) !== point.identity) throw new Error('Evaluation checkpoint was replaced');
          const world = this.reserveWorld(run, id); world.restoredFrom = point.identity;
          await this.publish(); this.binding(run).signal.throwIfAborted();
          // Exact memory restoration advances no game ticks; subsequent input is charged normally.
          return this.attach(run, world, await this.ports.restore(reference, id));
        });
      },
      remove: async reference => {
        const remaining = await this.collectPoints(this.run(runId), [reference]);
        if (remaining.length) throw new Error('Evaluation checkpoint still has retained descendants');
      },
      collect: async references => {
        const remaining = new Set(await this.collectPoints(this.run(runId), references));
        return references.filter(reference => !remaining.has(reference));
      },
    };
  }

  cleanup(runId: string): Promise<void> {
    const existing = this.cleaning.get(runId); if (existing) return existing;
    const run = this.saved.runs.find(item => item.id === runId); if (!run) return Promise.resolve();
    // Fence new dispatch synchronously, then join even operations whose caller lost its acknowledgment.
    run.closed = true;
    const pending = this.clean(run).finally(() => { this.cleaning.delete(runId); });
    this.cleaning.set(runId, pending); return pending;
  }
  async recover(): Promise<void> {
    const results = await Promise.allSettled(this.saved.runs.map(run => this.cleanup(run.id)));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Evaluation resource cleanup is incomplete');
  }

  private async clean(run: Run): Promise<void> {
    const failures: unknown[] = [];
    try { await this.publish(); } catch (error) { failures.push(error); }
    while (this.work.get(run.id)?.size) await Promise.allSettled([...this.work.get(run.id)!]);
    for (const world of run.worlds.filter(item => !item.released)) {
      try {
        await this.ports.destroy(world.id, world.identity, this.saved.owner, run.id, world.restoredFrom);
        world.released = true; this.runtimes.delete(world.id); await this.publish();
      } catch (error) { failures.push(error); }
    }
    try {
      const remaining = await this.collectPoints(run, run.checkpoints.filter(point => !point.released).map(point => point.reference), true);
      if (remaining.length) throw new Error('Evaluation checkpoints are still referenced by retained descendants');
    } catch (error) { failures.push(error); }
    try { await this.store.flush?.(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Evaluation run cleanup is incomplete');
  }

  private async attach(run: Run, entry: World, runtime: WorldRuntime): Promise<WorldRuntime> {
    if (runtime.id !== entry.id || !runtime.identity || this.saved.runs.some(item => item.worlds.some(other => other !== entry && other.identity === runtime.identity))) throw new Error('Evaluation runtime identity mismatch');
    entry.identity = runtime.identity; this.runtimes.set(entry.id, runtime); await this.publish();
    const { ledger, signal } = this.binding(run);
    return {
      id: entry.id, identity: runtime.identity,
      state: () => this.perform(run, () => runtime.state()), frame: () => this.perform(run, () => runtime.frame()),
      step: command => this.perform(run, async () => {
        const step = stepSchema.parse(command);
        return ledger.run({ owner: run.id, operation: 'vm-gameplay', reserve: { simulation: step.ticks } }, async () => {
          const before = await runtime.state(); const after = await runtime.step(step);
          return { value: after, usage: { simulation: after.tick - before.tick } };
        }, signal);
      }),
      branch: ids => this.perform(run, async () => {
        signal.throwIfAborted();
        if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Invalid evaluation fork batch');
        const parent = await this.ports.parentSnapshot(runtime);
        if (parent && !run.checkpoints.some(point => point.identity === parent) && !run.worlds.some(world => world.restoredFrom === parent)) throw new Error('Fork source has unowned snapshot lineage');
        const entries = ids.map(id => { const child = this.reserveWorld(run, id); if (parent) child.restoredFrom = parent; return child; });
        await this.publish(); signal.throwIfAborted();
        // VM forks copy the current memory; no replay or unmetered game initialization occurs.
        const children = await runtime.branch([...ids]);
        if (children.length !== ids.length || new Set(children.map(child => child.id)).size !== ids.length || children.some(child => !ids.includes(child.id))) throw new Error('Invalid evaluation fork result');
        return Promise.all(entries.map(child => this.attach(run, child, children.find(runtime => runtime.id === child.id)!)));
      }),
      destroy: () => {
        let releasing = this.releases.get(entry.id);
        if (!releasing) {
          releasing = this.perform(run, async () => {
            await runtime.destroy(); entry.released = true; this.runtimes.delete(entry.id); await this.publish();
          });
          this.releases.set(entry.id, releasing);
        }
        return releasing;
      },
    };
  }
  private async collectPoints(run: Run, references: string[], cleaning = false): Promise<string[]> {
    const work = async () => {
      const points = [...new Set(references)].map(reference => {
        const point = run.checkpoints.find(item => item.reference === reference);
        if (!point) throw new Error('Cannot collect an unowned evaluation checkpoint'); return point;
      }).filter(point => !point.released);
      if (!points.length) return [];
      const remaining = await this.ports.collect(points.map(({ reference, identity }) => ({ reference, identity })));
      if (remaining.some(reference => !points.some(point => point.reference === reference))) throw new Error('Invalid checkpoint cleanup result');
      for (const point of points) if (!remaining.includes(point.reference)) point.released = true;
      await this.publish(); return remaining;
    };
    return cleaning ? work() : this.perform(run, work);
  }
  private reserveWorld(run: Run, id: string): World {
    this.usable();
    if (this.saved.runs.some(item => item.worlds.some(world => world.id === id))) throw new Error('Evaluation world already has an owner');
    if (run.worlds.filter(world => !world.released).length >= 12) throw new Error('Evaluation resident VM limit reached');
    const world = worldSchema.parse({ id, released: false }); run.worlds.push(world); return world;
  }
  private perform<T>(run: Run, work: () => Promise<T>): Promise<T> {
    try { this.usable(); if (run.closed) throw new Error('Evaluation run is closed'); } catch (error) { return Promise.reject(error); }
    const active = this.work.get(run.id) ?? new Set<Promise<unknown>>(); this.work.set(run.id, active);
    const promise = work(); active.add(promise);
    void promise.then(() => active.delete(promise), () => active.delete(promise)); return promise;
  }
  private run(id: string): Run { const run = this.saved.runs.find(item => item.id === id); if (!run) throw new Error('Unknown evaluation run'); return run; }
  private binding(run: Run) { const binding = this.bindings.get(run.id); if (!binding) throw new Error('Evaluation run has no live budget'); return binding; }
  private usable(): void { if (this.failure) throw new Error('Evaluation resource publication failed; reopen for cleanup', { cause: this.failure.cause }); }
  private publish(): Promise<void> {
    const saved = structuredClone(this.saved);
    this.writes = this.writes.then(() => this.store.save(saved)).catch(cause => { this.failure = { cause }; throw cause; }); return this.writes;
  }
}
