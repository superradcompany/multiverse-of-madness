import assert from 'node:assert/strict';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import type { Step } from '../../examples/doom/contracts/src/game.ts';
import type { WorldRuntime } from '../../examples/doom/server/src/runtime.ts';

/** Real Doom with deterministic replay cloning, not a VM snapshot/performance test. */
export class EvaluationWorld implements WorldRuntime {
  readonly identity: string;
  private trace: Step[] = [];
  private constructor(readonly id: string, private engine: DoomEngine | undefined, private readonly budget: BudgetLedger, private readonly signal: AbortSignal) {
    this.identity = `evaluation:${id}`;
  }
  static async create(id: string, budget: BudgetLedger, signal: AbortSignal): Promise<EvaluationWorld> {
    const engine = await budget.run({ owner: id, operation: 'engine-initialization', reserve: { simulation: 35 } }, async () => {
      const value = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
      return { value, usage: { simulation: value.state().tick } };
    }, signal);
    return new EvaluationWorld(id, engine, budget, signal);
  }
  async state() { return this.current().state(); }
  async frame() { return Buffer.alloc(0); }
  async step(command: Step, operation = 'gameplay') {
    return this.budget.run({ owner: this.id, operation, reserve: { simulation: command.ticks } }, async () => {
      const engine = this.current(), before = engine.state().tick;
      const value = engine.step(command);
      this.trace.push(structuredClone(command));
      return { value, usage: { simulation: value.tick - before } };
    }, this.signal);
  }
  async branch(ids: string[]): Promise<EvaluationWorld[]> {
    const children: EvaluationWorld[] = [];
    try {
      for (const id of ids) {
        const child = await EvaluationWorld.create(id, this.budget, this.signal);
        children.push(child);
        for (const command of this.trace) await child.step(command, 'branch-reconstruction');
        assert.deepEqual(await child.state(), await this.state());
      }
      return children;
    } catch (error) { await Promise.all(children.map(child => child.destroy())); throw error; }
  }
  async destroy() { this.engine = undefined; }
  private current(): DoomEngine { if (!this.engine) throw new Error('Evaluation world has been destroyed'); return this.engine; }
}
