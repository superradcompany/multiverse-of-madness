import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGameDescription } from '@multiverse/gameplay-harness';
import { describeChess } from './description.ts';
import { ChessAdapter } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';

test('chess description matches observed field types, legal controls, timing, runtime copies and measured outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-description-'));
  try {
    const adapter = new ChessAdapter(), provider = new ChessRuntimeStore(root), description = describeChess(adapter.version, provider.capabilities);
    validateGameDescription(description, { adapter: adapter.version, capabilities: provider.capabilities });
    const world = await provider.create('source', new AbortController().signal), before = await world.state();
    for (const field of description.observations) {
      const value = before[field.path.slice(1) as keyof typeof before];
      assert.equal(Array.isArray(value) ? 'array' : typeof value, field.type, field.path);
    }
    const plans = await adapter.candidates(before);
    assert.deepEqual(plans.map(plan => plan.payload.san), before.legalMoves);
    const command = (await adapter.next(adapter.start(plans[0]!))).command!;
    const after = await world.step(command);
    assert.equal(adapter.clock(after).unit, description.timing.unit);
    assert.equal(after.ply - before.ply, 1);
    const measured = adapter.measure(before, after, adapter.initialStatistics(after));
    assert.deepEqual(Object.keys(measured.metrics).sort(), description.outcomes.metrics.map(metric => metric.id).sort());
    await world.captureCheckpoint('point');
    const restored = await provider.restore('point', 'restored', new AbortController().signal);
    assert.deepEqual(await restored.state(), after);
    assert.match(describeChess(new ChessAdapter('b').version, provider.capabilities, 'b').outcomes.success, /Black/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
