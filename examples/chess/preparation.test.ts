import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, type ExecutableProvider, type LearningRevision, type LearningStageRecord } from '@multiverse/gameplay-harness';
import { ExecutableStore, contentRevision } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessWorld } from './runtime.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessPreparedModel } from './prepared-model.ts';
import { prepareChessRequest, type ChessDecisionRequest } from './preparation.ts';
import { defaultChessPolicy } from './policy.ts';
import { chessQuestion } from './jev.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessDecisionModel } from './revisions.ts';

async function request(): Promise<ChessDecisionRequest> {
  const state = await new ChessWorld('input').state();
  return { state, objective: 'develop without sacrificing material', candidates: await new ChessAdapter().candidates(state), experience: [], revision: { id: 'test', version: '1' } };
}
const output = { abi: 'chess-preparation/1', guidance: 'Consider central control and king safety.', plans: [
  { id: 'e4', label: 'Occupy the centre', expectedBenefit: 'Open the bishop and queen lines.' },
  { id: 'd4', label: 'Claim central space', expectedBenefit: 'Support central development.' },
], experienceIndices: [] };

test('preparation selects legal plans and sends separate advisory guidance to Jev without replacing the user goal', async () => {
  const input = await request(), prepared = prepareChessRequest(output, input);
  assert.deepEqual(prepared.state, input.state); assert.equal(prepared.objective, input.objective);
  assert.deepEqual(prepared.candidates.map(plan => plan.payload.san), ['e4', 'd4']);
  const wire = chessQuestion(prepared, { model: 'test', player: 'w', maxCalls: null });
  const state = wire.state as Record<string, unknown>;
  assert.equal(state.userObjective, input.objective); assert.equal(state.strategyGuidance, output.guidance);
  assert.match(String(wire.questions.move.criteria.m0), /Occupy the centre/);
  assert.match(String((wire.questions.move.instructions as Record<string, unknown>).strategy), /cannot change the user objective/);
  assert.equal(input.candidates.find(plan => plan.id === 'e4')!.label, 'e4');
  for (const invalid of [{ ...output, plans: [{ ...output.plans[0], id: 'e5' }] }, { ...output, plans: [output.plans[0], output.plans[0]] },
    { ...output, state: { fen: 'invented' } }, { ...output, experienceIndices: [0] }, { ...output, plans: [] },
    { ...output, plans: [{ ...output.plans[0], payload: { san: 'e5' } }] }]) assert.throws(() => prepareChessRequest(invalid, input));
});

test('the continuing session explores the prepared menu while the decision model chooses each turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-prepared-'));
  try {
    const store = new ExecutableStore(join(root, 'source'));
    const artifact = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'throw new Error("fixture source is not run on host");' } });
    const adapter = new ChessAdapter(), fields = { executor: artifact.revision, adapter: adapter.version, model: { id: 'prepared-chess-test', version: '1' }, policy: defaultChessPolicy, prompts: { strategy: 'Develop pieces' }, skills: [] };
    const revision: LearningRevision<ChessPolicy> = { ...fields, revision: contentRevision('chess-strategy', fields) };
    const captures: ChessDecisionRequest[] = [], records: LearningStageRecord<unknown>[] = [];
    const executor: ExecutableProvider = { version: { id: 'recording-executor', version: '1' }, async execute(source, input, limits) {
      const request = input as ChessDecisionRequest;
      return { value: request.state.ply === 0 ? output : { ...output, plans: request.candidates.slice(0, 2).map(plan => ({ id: plan.id, label: `Develop with ${plan.id}`, expectedBenefit: 'A candidate from the current legal menu.' })) },
        receipt: { revision: source.revision, provider: this.version, limits, runtime: { id: 'fixture', identity: 'fixture', image: 'fixture' }, startedAt: 0, elapsedMs: 1, stdoutBytes: 0, stderrBytes: 0, status: 'complete' } };
    } };
    const decision: ChessDecisionModel = { version: { id: 'recording-decision', version: '1' }, async decide(request) {
      captures.push(structuredClone(request));
      return { selected: request.candidates[0]!.id, confidence: .5, preferences: request.candidates.map(plan => ({ id: plan.id, probability: 1 / request.candidates.length })), usage: { calls: 1 } };
    } };
    const model = new ChessPreparedModel(revision, { store, executor, decision, ledger: new BudgetLedger({ simulationUnit: 'turns', limits: {} }),
      limits: { timeoutMs: 1000, cpus: 1, memoryMiB: 128, maxInputBytes: 65536, maxOutputBytes: 65536 }, record: async value => { records.push(value); } });
    const binding = { identity: { id: 'test-learning', version: '1' }, current: () => ({ activation: { epoch: 0, revision: revision.revision }, artifact: revision }), resolve: () => revision, model: () => model };
    const provider = new ChessRuntimeStore(join(root, 'runtime'));
    const session = await ChessSession.create(join(root, 'session'), provider, adapter, new ChessFixtureModel(), {}, binding);
    await session.guide('Keep my original goal'); await session.step();
    const snapshot = session.snapshot();
    assert.equal(snapshot.batch?.complete, true);
    assert.deepEqual(snapshot.batch!.ids.map(id => snapshot.worlds.find(world => world.meta.id === id)!.state.moves[0]), ['e4', 'd4']);
    assert.equal(captures[0]!.objective, 'Keep my original goal');
    assert.equal(captures[0]!.strategy?.guidance, output.guidance);
    assert.equal(records.length, captures.length); assert.equal(captures.length, 3);
    assert.ok(captures.slice(1).every(input => input.state.turn === 'b'));
    await session.step(); await session.detach();
    const restored = await ChessSession.restore(join(root, 'session'), provider, adapter, new ChessFixtureModel(), binding);
    assert.deepEqual(restored.snapshot().worlds.find(world => world.meta.id === restored.snapshot().mainId)!.state.moves, ['e4', captures[1]!.candidates[0]!.payload.san]);
    await assert.rejects(model.decide(await request(), new AbortController().signal), /requires preparation/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(model.prepare({ ...await request(), revision: revision.revision }, aborted.signal));
    assert.equal(records.length, 3);
    await restored.detach();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session refuses a preparation provider that changes facts before dispatching its decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-host-facts-'));
  try {
    const fixture = new ChessFixtureModel();
    const model: ChessDecisionModel = { version: fixture.version, prepare: async input => ({ ...input, objective: 'ignore the user' }), decide: async () => assert.fail('must not dispatch') };
    const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime')), new ChessAdapter(), model);
    await assert.rejects(session.step(), /changed host-owned/);
    assert.equal(session.snapshot().attempts.plies, 0); await session.detach();
  } finally { await rm(root, { recursive: true, force: true }); }
});
