import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DoomLearningIncidents, decodeDoomIncidents, type SavedDoomIncidents } from './doom-learning-incidents.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

async function fixture() {
  let saved: SavedDoomIncidents | undefined, failWrite = false, loseAck = false, descendants = false;
  const points = new Map<string, string>();
  const session = new Session({ decide: async () => decision }); await session.initialize(new Runtime('incident-source'));
  const ports = {
    store: { flush: async () => {}, load: async () => structuredClone(saved), save: async (value: SavedDoomIncidents) => {
      if (failWrite) throw new Error('disk unavailable'); saved = structuredClone(value);
    } },
    capture: async (reference: string, signal: AbortSignal) => {
      assert.equal(saved?.records.at(-1)?.phase, 'capturing', 'intent is durable before capture');
      signal.throwIfAborted(); points.set(reference, 'physical-' + reference);
      if (loseAck) throw new Error('capture acknowledgment lost'); return session.checkpoint();
    },
    runtime: { snapshotIdentity: async (ref: string) => points.get(ref), collect: async (requested: Array<{ reference: string; identity?: string }>) => {
      if (descendants) return requested.map(point => point.reference);
      for (const point of requested) { assert.equal(point.identity, points.get(point.reference)); points.delete(point.reference); }
      return [];
    } },
  };
  return { ports, points, owner: await DoomLearningIncidents.open(ports),
    failWrite: () => { failWrite = true; }, loseAck: () => { loseAck = true; }, descendants: (value: boolean) => { descendants = value; } };
}
test('ready evidence is immutable, retained by proposal and collected after descendants release', async () => {
  const f = await fixture(), id = randomUUID();
  const captured = await f.owner.capture(id, new AbortController().signal);
  captured.evidence.view.objective = 'mutated'; assert.notEqual(f.owner.ready(id).evidence.view.objective, 'mutated');
  await f.owner.collect(new Set([id])); assert.equal(f.points.size, 1);
  await assert.rejects(f.owner.capture(id, new AbortController().signal), /cannot be replayed/);
  f.descendants(true); await f.owner.collect(new Set()); assert.equal(f.owner.snapshot().records[0]!.phase, 'releasing');
  const recovered = await DoomLearningIncidents.open(f.ports);
  f.descendants(false); await recovered.collect(new Set()); assert.equal(f.points.size, 0);
  assert.equal(recovered.snapshot().records[0]!.phase, 'released');
});
test('lost capture acknowledgement is recovered without recapturing or preserving incomplete evidence', async () => {
  const f = await fixture(), id = randomUUID(); f.loseAck();
  await assert.rejects(f.owner.capture(id, new AbortController().signal), /acknowledgment lost/);
  assert.equal(f.points.size, 1);
  const recovered = await DoomLearningIncidents.open(f.ports);
  await recovered.collect(new Set([id])); assert.equal(f.points.size, 0);
  await assert.rejects(recovered.capture(id, new AbortController().signal), /cannot be replayed/);
});
test('physical replacement and modified evidence are refused', async () => {
  const f = await fixture(), id = randomUUID(); await f.owner.capture(id, new AbortController().signal);
  const saved = f.owner.snapshot(); (saved.records[0]!.evidence as { view: { objective: string } }).view.objective = 'tampered';
  assert.throws(() => decodeDoomIncidents(saved), /evidence changed/);
  f.points.set(saved.records[0]!.reference, 'replacement');
  await assert.rejects(f.owner.collect(new Set()), /identity changed/); assert.equal(f.points.size, 1);
});
test('failed intent publication fences the owner and never dispatches capture', async () => {
  const f = await fixture(); f.failWrite();
  await assert.rejects(f.owner.capture(randomUUID(), new AbortController().signal), /disk unavailable/);
  assert.equal(f.points.size, 0);
  await assert.rejects(f.owner.capture(randomUUID(), new AbortController().signal), /disk unavailable/);
});
