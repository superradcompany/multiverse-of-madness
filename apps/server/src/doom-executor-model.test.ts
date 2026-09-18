import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, type ExecutableProvider, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { DoomExecutableModel, type DoomExecutorDecision } from './doom-executor-model.ts';
import { Session } from './session.ts';
import type { DoomPolicy } from './doom-policy.ts';
import { decision, initial } from '../test-support/fixture-runtime.ts';

type Packet = { state: typeof initial; objective: string; stats: unknown; feedback: unknown; previousPlan?: unknown; userSkills: unknown[];
  candidates: Array<{ id: string; plan?: unknown }>; learning: { prompts: Record<string, string>; skills: unknown[] } };
async function fixture(limit = 10) {
  const directory = await mkdtemp(join(tmpdir(), 'doom-executor-test-')), store = new ExecutableStore(directory);
  const code = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'throw new Error("Source must never execute on the test host")' } });
  const fields = { policy: new Session({ decide: async () => decision }).learningPolicy(), prompts: { strategy: 'use observations' },
    skills: [{ id: 'training', instructions: 'check clearance' }], adapter: { id: 'doom-adapter', version: 'test' },
    executor: code.revision, model: { id: 'isolated-ranker', version: '1' } };
  const revision: LearningRevision<DoomPolicy> = { ...fields, revision: contentRevision('doom-learning-test', fields) };
  const seen: Packet[] = [], records: DoomExecutorDecision[] = [];
  const hooks: { output?: (input: Packet) => unknown } = {};
  const executor: ExecutableProvider = { version: { id: 'fixture-executor', version: '1' }, execute: async (artifact, input, limits, signal) => {
    signal.throwIfAborted(); assert.deepEqual(artifact.revision, code.revision);
    const packet = structuredClone(input) as Packet; seen.push(packet);
    const selected = packet.candidates[0]!.id;
    return { value: hooks.output?.(packet) ?? { selected, confidence: 1, priority: 'exploration', preferences: packet.candidates.map(item => ({ id: item.id, probability: item.id === selected ? 1 : 0 })) },
      receipt: { revision: artifact.revision, provider: executor.version, limits, runtime: { id: 'fixture', identity: 'fixture', image: 'fixture' }, startedAt: 0, elapsedMs: 2, stdoutBytes: 100, stderrBytes: 0, status: 'complete' } };
  } };
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { executorCalls: limit } });
  const model = new DoomExecutableModel(revision, { store, executor, ledger,
    limits: { timeoutMs: 1000, cpus: 1, memoryMiB: 128, maxInputBytes: 65536, maxOutputBytes: 16384 },
    record: async value => { records.push(value); } });
  return { model, seen, records, ledger, hooks, remove: () => rm(directory, { recursive: true, force: true }) };
}

test('isolated Doom rankers receive the guide, current stats, barriers, user skills and revision data; host owns commands', async () => {
  const f = await fixture();
  try {
    const result = await f.model.decide(initial, 'Conserve ammunition', [initial], new AbortController().signal, [], 7,
      { skills: [{ id: '019cf487-0087-756e-8c87-f32212656aff', name: 'Stay mobile', instructions: 'Move away from walls', enabled: true }] });
    assert.equal(f.seen[0]!.objective, 'Conserve ammunition'); assert.deepEqual(f.seen[0]!.state, initial);
    assert.ok(f.seen[0]!.stats); assert.ok(f.seen[0]!.feedback); assert.equal(f.seen[0]!.userSkills.length, 1);
    assert.equal(f.seen[0]!.learning.prompts.strategy, 'use observations'); assert.equal(f.seen[0]!.learning.skills.length, 1);
    assert.ok(result.perception?.excludedActions.includes('fire'), 'no enemy is available to fire at');
    assert.equal(result.probabilities.fire, 0); assert.equal(result.model, 'isolated-ranker@1');
    assert.equal(f.ledger.used('executorCalls'), 1); assert.equal(f.ledger.used('executorWallMs'), 2);
    assert.equal(f.records.length, 1); assert.equal(result.usage, undefined, 'no Jev call is fabricated');
    const planned = await f.model.decide(initial, 'Explore', [initial], new AbortController().signal, [], 7, { planTicks: 35 });
    assert.ok(planned.plans?.candidates.length); assert.ok(f.seen[1]!.candidates.every(item => item.plan));
  } finally { await f.remove(); }
});

test('untrusted Doom decisions cannot choose unavailable actions, omit probabilities or inject commands/scores', async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      (packet: Packet) => ({ selected: 'fire', confidence: 1, priority: 'combat', preferences: packet.candidates.map(item => ({ id: item.id, probability: 1 / packet.candidates.length })) }),
      (packet: Packet) => ({ selected: packet.candidates[0]!.id, confidence: 1, priority: 'exploration', preferences: [] }),
      (packet: Packet) => ({ selected: packet.candidates[0]!.id, confidence: 1, priority: 'exploration', preferences: packet.candidates.map(item => ({ id: item.id, probability: 1 / packet.candidates.length })), commands: ['teleport'], score: 999 }),
    ]) {
      f.hooks.output = mutate;
      await assert.rejects(f.model.decide(initial, 'Explore', [], new AbortController().signal));
    }
    assert.equal(f.records.length, 3, 'rejected raw outputs remain auditable');
    assert.equal(f.ledger.used('executorCalls'), 3, 'invalid outputs still consume the actual invocations');
  } finally { await f.remove(); }
});

test('exhausted or cancelled Doom executor calls never dispatch source', async () => {
  const f = await fixture(0);
  try {
    await assert.rejects(f.model.decide(initial, 'Explore', [], new AbortController().signal), /Budget exhausted/);
    const control = new AbortController(); control.abort();
    await assert.rejects(f.model.decide(initial, 'Explore', [], control.signal));
    assert.equal(f.seen.length, 0);
  } finally { await f.remove(); }
});


test('isolated decision code receives the same authoritative previous-plan evidence it records', async () => {
  const f = await fixture();
  try {
    const previousPlan = { id: 'supply', label: 'collect supply', status: 'replan' as const, reason: 'target became obstructed', step: 0,
      target: { kind: 'pickup' as const, engineType: 54, x: 100, y: 0, z: 0 }, episode: initial.episode, map: initial.map,
      startedTick: initial.tick, observedTick: initial.tick, ticksSinceStarted: 0 };
    const result = await f.model.decide(initial, 'Explore', [], new AbortController().signal, [], 35, { previousPlan });
    assert.deepEqual(f.seen[0]!.previousPlan, previousPlan);
    assert.deepEqual(result.evidence?.previousPlan, previousPlan);
  } finally { await f.remove(); }
});
