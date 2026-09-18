import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { BudgetLedger, type ExecutableProvider } from '@multiverse/gameplay-harness';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import { doomPreparationInput } from './doom-preparation-input.ts';
import { prepareDoomContext } from './doom-preparation.ts';
import { DoomPreparedModel } from './doom-prepared-model.ts';
import { doomLearningArtifact } from './doom-learning-models.ts';
import { Session } from './session.ts';
import { decision, initial } from '../test-support/fixture-runtime.ts';
import type { Experience } from './experience.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'doom-prepared-model-')), store = new ExecutableStore(directory);
  const source = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'throw new Error("must not execute on the host")' } });
  const policy = new Session({ decide: async () => decision }).learningPolicy(); policy.memory.enabled = true; policy.memory.perDecision = 1;
  const revision = doomLearningArtifact({ policy, prompts: {}, skills: [], adapter: { id: 'test', version: '1' }, executor: source.revision, model: { id: 'prepared-doom-jev', version: 'jev-latest' } });
  const preparations: any[] = [], requests: any[] = [], records: unknown[] = [];
  const hooks: { invalid?: boolean; abort?: () => void } = {};
  const executor: ExecutableProvider = { version: { id: 'test', version: '1' }, execute: async (artifact, input, limits) => {
    const packet = input as any; preparations.push(packet); hooks.abort?.();
    return { value: { abi: 'doom-preparation/1', historyIndices: [], experienceIndices: hooks.invalid ? [99] : packet.experienceLimit ? [1] : [], features: { avoidRepeatedHeading: true },
      ...(packet.planTicks ? { plans: [{ id: 'learned_opening', label: 'Test a generated opening', steps: [{ kind: 'move', label: 'Follow new waypoint', target: { kind: 'point', x: initial.x + 96, y: initial.y + 32, z: initial.z }, maxTicks: 35 }] }] } : {}) },
      receipt: { revision: artifact.revision, provider: executor.version, limits, runtime: { id: 'fixture', identity: 'fixture', image: 'fixture' }, status: 'complete', startedAt: 0, elapsedMs: 3, stdoutBytes: 100, stderrBytes: 0 } };
  } };
  const client = { systemOne: async (body: any) => {
    requests.push(structuredClone(body));
    return { model: 'fixture-jev', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
      const ids = Object.keys(question.criteria), choice = ids.includes('wait') ? 'wait' : ids[0];
      return [key, { choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
    })) };
  } } as unknown as Pick<TypeSafeClient, 'systemOne'>;
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { executorCalls: 4, modelCalls: 4 } });
  const model = new DoomPreparedModel(revision, { store, executor, client, ledger, limits: { timeoutMs: 1000, cpus: 1, memoryMiB: 128, maxInputBytes: 1048576, maxOutputBytes: 16384 }, record: async value => { records.push(value); } });
  const memory = (action: string): Experience => ({ worldId: action, action, start: { episode: 1, map: 1, x: 0, y: 0, z: 0, angle: 0, health: 100, ammo: true }, result: { ticks: 35, health: -10, kills: 0, ammo: 0, moved: 0, died: false, exited: false } });
  const experience = [memory('host-selected'), memory('program-selected')];
  return { model, revision, policy, preparations, requests, records, ledger, experience, hooks, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('prepared Jev uses generated plans and independently selected memory while retaining authoritative guide, stats and user skills', async () => {
  const f = await fixture();
  try {
    const result = await f.model.decide(initial, 'Collect health first', [initial], new AbortController().signal, [f.experience[0]!], 35,
      { policy: f.policy, planTicks: 210, experiencePool: f.experience, skills: [{ id: 'user', name: 'My guide', enabled: true, instructions: 'Avoid wasting ammunition' }] });
    assert.deepEqual(f.preparations[0].defaultExperienceIndices, [0]); assert.equal(f.preparations[0].experience.length, 2);
    assert.deepEqual(Object.keys(f.requests[0].questions.plan.criteria), ['learned_opening']);
    assert.equal(f.requests[0].state.objective, 'Collect health first'); assert.equal(f.requests[0].state.stats.current.health, 100);
    assert.equal(f.requests[0].state.skills[0].instructions, 'Avoid wasting ammunition');
    assert.equal(f.requests[0].state.experience[0].action, 'program-selected');
    assert.equal(f.requests[0].state.prepared.features.avoidRepeatedHeading, true); assert.match(f.requests[0].state.prepared.scope, /not observed facts/);
    assert.equal(result.plans!.selected, 'learned_opening'); assert.equal(result.selectedExperience![0]!.action, 'program-selected');
    assert.deepEqual(result.preparation!.experienceIndices, [1]); assert.equal(result.model, 'fixture-jev');
    assert.equal(f.ledger.used('executorCalls'), 1); assert.equal(f.ledger.used('modelCalls'), 1); assert.equal(f.ledger.used('inputTokens'), 10);
    assert.equal(f.records.length, 1);
  } finally { await f.cleanup(); }
});
test('disabled memory stays unavailable to preparation and action mode stays action-only', async () => {
  const f = await fixture();
  try {
    f.policy.memory.enabled = false;
    const result = await f.model.decide(initial, 'Explore', [], new AbortController().signal, [], 35, { policy: f.policy, experiencePool: f.experience });
    assert.deepEqual(f.preparations[0].experience, []); assert.equal(f.preparations[0].experienceLimit, 0);
    assert.equal(result.plans, undefined); assert.equal(result.experienceUsed, 0);
  } finally { await f.cleanup(); }
});
test('invalid or cancelled preparations retain their receipt but cannot call Jev', async () => {
  const f = await fixture();
  try {
    f.hooks.invalid = true;
    await assert.rejects(f.model.decide(initial, 'Explore', [], new AbortController().signal, [], 35), /invalid or duplicate/);
    assert.equal(f.records.length, 1); assert.equal(f.ledger.used('executorCalls'), 1); assert.equal(f.ledger.used('modelCalls'), 0);
    f.hooks.invalid = false; const control = new AbortController(); f.hooks.abort = () => control.abort();
    await assert.rejects(f.model.decide(initial, 'Explore', [], control.signal));
    assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});


test('default candidate plans can be reused under the strict preparation output contract at a short horizon', async () => {
  const f = await fixture();
  try {
    const input = await doomPreparationInput(f.revision, initial, 'Explore', [initial], [], 7, { planTicks: 7 });
    assert.ok(input.defaultPlans?.length);
    const prepared = prepareDoomContext({ abi: input.abi, plans: input.defaultPlans, historyIndices: [0], experienceIndices: [], features: {} }, input);
    assert.ok(prepared.plans!.every(plan => plan.steps.every(step => step.maxTicks <= 7)));
    assert.ok(input.defaultPlans.every(plan => !('evidence' in plan) && !('novelty' in plan)));
  } finally { await f.cleanup(); }
});


test('local failure feedback survives preparation even when the program discards all history and memory', async () => {
  const f = await fixture();
  try {
    f.policy.memory.enabled = false;
    const previousPlan = { id: 'supply', label: 'collect supply', status: 'replan' as const, reason: 'target became obstructed', step: 0,
      target: { kind: 'pickup' as const, engineType: 54, x: 100, y: 0, z: 0 }, episode: initial.episode, map: initial.map,
      startedTick: initial.tick, observedTick: initial.tick, ticksSinceStarted: 0 };
    const result = await f.model.decide(initial, 'Explore', [], new AbortController().signal, [], 35, { policy: f.policy, planTicks: 210, previousPlan });
    assert.deepEqual(f.preparations[0].previousPlan, previousPlan);
    assert.deepEqual(f.requests[0].state.previousPlan, previousPlan);
    assert.deepEqual(result.evidence?.previousPlan, previousPlan);
    assert.equal(result.experienceUsed, 0);
  } finally { await f.cleanup(); }
});
