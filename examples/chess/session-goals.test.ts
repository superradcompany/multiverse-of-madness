import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessAdapter } from './adapter.ts';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';
import { prepareChessRequest } from './preparation.ts';
import { ChessWebController } from './web-controller.ts';

const model: ChessDecisionModel = { version: { id: 'goal-fixture', version: '1' },
  async prepare(request) { return prepareChessRequest({ abi: 'chess-preparation/2', guidance: '',
    plans: request.candidates.filter(plan => request.state.ply > 0 || ['Nf3', 'd4'].includes(plan.id)).map(plan => ({ id: plan.id, label: plan.label, expectedBenefit: plan.expectedBenefit })), experienceIndices: [],
    temporaryGoal: { key: 'knight', instruction: 'Develop a knight to f3', reason: 'Try a development route', evidence: ['current-state'], duration: 6, target: { kind: 'occupy', square: 'f3', piece: 'n' } },
  }, request); },
  async decide(request) { return { selected: request.candidates[0]!.id, confidence: .5, preferences: request.candidates.map(plan => ({ id: plan.id, probability: 1 / request.candidates.length })), usage: { calls: 0 } }; },
};
const main = (snapshot: ChessSessionCheckpoint) => snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!;

test('goals survive chess futures, promotion, replay, reconnect and rollback while a changed guide invalidates them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-session-goals-')), adapter = new ChessAdapter(), provider = new ChessRuntimeStore(join(root, 'runtime'));
  try {
    const session = await ChessSession.create(root, provider, adapter, model, { trialPlies: 2 });
    await session.step();
    const saved = session.snapshot(); assert.equal(saved.version, 3); assert.ok(saved.goalScopeId);
    const children = saved.worlds.filter(world => world.meta.role === 'experiment'); assert.equal(children.length, 2);
    const source = main(saved).temporaryGoal!;
    assert.equal(source.record.status, 'active');
    assert.deepEqual(children.map(world => world.temporaryGoal!.record.status).sort(), ['active', 'completed']);
    for (const child of children) { assert.equal(child.temporaryGoal!.record.id, source.record.id); assert.equal(child.temporaryGoal!.record.expiresAt, 6); }
    assert.equal(new ChessWebController(session).view().worlds[0]!.temporaryGoal!.record.id, source.record.id);
    await session.step(); await session.detach();
    const restored = await ChessSession.restore(root, provider, adapter, model);
    assert.equal(main(restored.snapshot()).temporaryGoal!.record.id, source.record.id);
    const replay = await restored.replayFrame(2); assert.equal(replay.world.temporaryGoal!.record.id, source.record.id);
    const point = await restored.checkpoint(); await restored.guide('Avoid all exchanges'); await restored.rollback(point);
    // A completed goal stays historical; an unfinished goal cannot survive a guide change.
    assert.notEqual(main(restored.snapshot()).temporaryGoal!.record.status, 'active');
    assert.equal(main(restored.snapshot()).temporaryGoal!.record.expiresAt, 6);
    await restored.detach();
    const path = join(root, 'session.json'), bytes = await readFile(path, 'utf8'), corrupt = JSON.parse(bytes);
    corrupt.version = 1; await writeFile(path, JSON.stringify(corrupt));
    await assert.rejects(ChessSession.restore(root, provider, adapter, model), /format 3/);
    await writeFile(path, bytes);
    assert.equal(main((await ChessSession.restore(root, provider, adapter, model)).snapshot()).temporaryGoal!.record.id, source.record.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('a new chess game retains old goal evidence but cannot inherit or renew the old pursuit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-new-game-goal-')), adapter = new ChessAdapter(), provider = new ChessRuntimeStore(join(root, 'runtime'));
  const losing: ChessDecisionModel = { ...model, prepare: async request => prepareChessRequest({ abi: 'chess-preparation/2', guidance: '',
    plans: request.candidates.map(plan => ({ id: plan.id, label: plan.label, expectedBenefit: plan.expectedBenefit })), experienceIndices: [],
    temporaryGoal: { key: 'knight', instruction: 'Develop a knight', reason: 'Lifecycle fixture', evidence: ['current-state'], duration: 20, target: { kind: 'occupy', square: 'f3', piece: 'n' } },
  }, request), decide: async request => {
    const selected = ['f3', 'e5', 'g4', 'Qh4#'][request.state.ply]!;
    return { selected, confidence: 1, preferences: request.candidates.map(plan => ({ id: plan.id, probability: Number(plan.id === selected) })), usage: { calls: 0 } };
  } };
  try {
    const session = await ChessSession.create(root, provider, adapter, losing, { threshold: 0 });
    for (let i = 0; i < 4; i++) await session.step();
    const ended = session.snapshot(), oldGoal = main(ended).temporaryGoal!;
    assert.equal(oldGoal.record.status, 'failed');
    await session.newGame(ended.mainId);
    assert.equal(main(session.snapshot()).temporaryGoal, undefined);
    await session.detach();
    const restored = await ChessSession.restore(root, provider, adapter, losing);
    assert.equal((await restored.replayFrame(4, ended.mainId)).world.temporaryGoal!.record.status, 'failed');
    await restored.step();
    const newGoal = main(restored.snapshot()).temporaryGoal!;
    assert.notEqual(newGoal.record.id, oldGoal.record.id);
    assert.notDeepEqual(newGoal.record.created.scope, oldGoal.record.created.scope);
    assert.equal(newGoal.record.status, 'active'); await restored.detach();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted rollback rechecks the checkpoint goal against the current user objective', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-goal-rollback-')), adapter = new ChessAdapter(), provider = new ChessRuntimeStore(join(root, 'runtime'));
  const player: ChessDecisionModel = { ...model, decide: async request => ({ selected: 'd4', confidence: 1,
    preferences: request.candidates.map(plan => ({ id: plan.id, probability: Number(plan.id === 'd4') })), usage: { calls: 0 } }) };
  try {
    const session = await ChessSession.create(root, provider, adapter, player, { threshold: 0 });
    await session.step();
    const goal = main(session.snapshot()).temporaryGoal!;
    assert.equal(goal.record.status, 'active');
    const point = await session.checkpoint();
    await session.guide('Avoid all exchanges');
    const checkpoints = provider.checkpoints.bind(provider);
    provider.checkpoints = () => {
      const original = checkpoints();
      return { ...original, restore: async (reference, id) => {
        await original.restore(reference, id);
        throw new Error('Lost restore acknowledgment');
      } };
    };
    await assert.rejects(session.rollback(point), /Lost restore acknowledgment/);
    const pending = session.snapshot().points.pendingRestore!;
    assert.ok(pending);
    await session.detach();
    const restored = await ChessSession.restore(root, new ChessRuntimeStore(join(root, 'runtime')), adapter, player);
    const recovered = restored.snapshot(), current = main(recovered);
    assert.equal(recovered.objective, 'Avoid all exchanges');
    assert.equal(recovered.mainId, pending.id);
    assert.equal(recovered.points.pendingRestore, undefined);
    assert.equal(current.temporaryGoal!.record.id, goal.record.id);
    assert.equal(current.temporaryGoal!.record.status, 'invalidated');
    assert.equal(current.temporaryGoal!.record.expiresAt, goal.record.expiresAt);
    assert.deepEqual(current.state.moves, ['d4']);
    await restored.detach();
    const reopened = await ChessSession.restore(root, new ChessRuntimeStore(join(root, 'runtime')), adapter, player);
    assert.equal(main(reopened.snapshot()).temporaryGoal!.record.status, 'invalidated');
    await reopened.detach();
  } finally { await rm(root, { recursive: true, force: true }); }
});
