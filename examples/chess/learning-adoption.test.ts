import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessSession } from './session.ts';
import { openChessSession } from './session-startup.ts';
import { chessLearningBaselinePolicy, defaultChessPolicy } from './policy.ts';
import type { ChessLearningBinding } from './revisions.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';

const persisted = (value: unknown) => JSON.parse(JSON.stringify(value));
const main = (saved: ChessSessionCheckpoint) => saved.worlds.find(world => world.meta.id === saved.mainId)!;
async function fixture(policy: Partial<ChessPolicy> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chess-adoption-'));
  const adapter = new ChessAdapter(), model = new ChessFixtureModel();
  const provider = () => new ChessRuntimeStore(join(directory, 'runtime'));
  const session = await ChessSession.create(directory, provider(), adapter, model, { threshold: 0, ...policy });
  const fields = { adapter: adapter.version, model: { id: 'prepared-fixture', version: '1' },
    executor: { id: 'preparation-fixture', version: '1' }, policy: session.policy, prompts: {}, skills: [] };
  const artifact = { ...fields, revision: contentRevision('adoption-fixture', fields) };
  const activation = { epoch: 0, revision: artifact.revision };
  let decisions = 0, opened = 0, closed = 0;
  const binding: ChessLearningBinding = {
    identity: contentRevision('fixture-journal', { directory }), current: () => ({ activation, artifact }),
    resolve: value => { assert.deepEqual(value, activation); return artifact; },
    model: () => ({ version: artifact.model, decide: (request, signal) => { decisions++; return model.decide(request, signal); } }),
  };
  const host = { binding, close: async () => { closed++; } };
  return { directory, session, binding, artifact, activation, model,
    get decisions() { return decisions; }, get opened() { return opened; }, get closed() { return closed; },
    read: () => readFile(join(directory, 'session.json'), 'utf8'),
    write: (saved: ChessSessionCheckpoint) => writeFile(join(directory, 'session.json'), JSON.stringify(saved)),
    reopen: (learning?: ChessLearningBinding) => ChessSession.restore(directory, provider(), adapter, model, learning),
    start: (learningRequested: boolean, adoptionRequested: boolean) => openChessSession({ directory, provider: provider(), adapter, model,
      learningRequested, adoptionRequested, openLearning: async () => { opened++; return host; } }),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

test('explicit startup adoption preserves board, policy, guide, attempts, evidence, checkpoints and replay; only new moves use learning', async () => {
  const f = await fixture({ checkpointEvery: 2, memoryCapacity: 17 });
  try {
    await f.session.guide('develop before attacking');
    await f.session.step(); await f.session.step();
    const before = f.session.snapshot(), replay = await f.session.replay(), frame = await f.session.replayFrame(1);
    const baseline = contentRevision('test-policy', chessLearningBaselinePolicy(before));
    const opened = await f.start(true, true), adopted = opened.session.snapshot();
    assert.equal(f.decisions, 0); assert.equal(f.opened, 1);
    assert.deepEqual(persisted(adopted), persisted({ ...before, version: 4, goalScopeId: adopted.goalScopeId, learning: f.binding.identity,
      learningAdoption: { initial: f.activation, mainId: before.mainId, ply: 2 } }));
    assert.deepEqual(await opened.session.replay(), replay);
    assert.deepEqual(await opened.session.replayFrame(1), frame);
    const restored = (await f.start(false, false)).session;
    assert.deepEqual(contentRevision('test-policy', chessLearningBaselinePolicy(restored.snapshot())), baseline);
    assert.deepEqual(chessLearningBaselinePolicy({ ...before, learning: f.binding.identity }), defaultChessPolicy);
    assert.deepEqual(chessLearningBaselinePolicy(), defaultChessPolicy);
    assert.deepEqual(restored.snapshot(), adopted); assert.equal(f.decisions, 0);
    await restored.step();
    assert.equal(f.decisions, 1); assert.deepEqual(main(restored.snapshot()).provenance.learning, f.activation);
    assert.deepEqual((await restored.replayFrame(1)).world.provenance, before.provenance);
    assert.deepEqual((await restored.replayFrame(3)).world.provenance.learning, f.activation);
    await restored.rollback(before.points.points[0]!.id);
    assert.equal(main(restored.snapshot()).provenance.learning, undefined);
    const rolled = await f.reopen(f.binding); await rolled.step();
    assert.deepEqual(main(rolled.snapshot()).provenance.learning, f.activation);
    await assert.rejects(f.reopen(), /original learning supervisor/);
    await assert.rejects(rolled.adoptLearning(f.binding), /already has/);
  } finally { await f.remove(); }
});

test('no implicit migration or unresolved-comparison adoption opens a learning host', async () => {
  const f = await fixture({ threshold: 1 });
  try {
    const raw = await f.read();
    await assert.rejects(f.start(true, false), /CHESS_ADOPT_LEARNING/);
    assert.equal(await f.read(), raw); assert.equal(f.opened, 0);
    await f.session.step(); const compared = f.session.snapshot();
    assert.ok(compared.batch);
    await assert.rejects(f.start(true, true), /Continue the existing comparison/);
    assert.equal(f.opened, 0); assert.deepEqual(JSON.parse(await f.read()), JSON.parse(JSON.stringify(compared)));
    await assert.rejects(f.session.adoptLearning(f.binding), /Resolve the active comparison/);
    await f.session.step();
    assert.equal((await f.start(true, true)).session.snapshot().version, 4);
  } finally { await f.remove(); }
});

test('adoption rejects changed policies, already-used baselines and invalid models without changing the save', async () => {
  const f = await fixture();
  try {
    const raw = await f.read();
    const policy = f.artifact.policy;
    f.artifact.policy = { ...policy, breadth: policy.breadth + 1 };
    await assert.rejects(f.start(true, true), /preserve the existing policy/);
    assert.equal(f.closed, 1); assert.equal(await f.read(), raw);
    f.artifact.policy = policy; f.activation.epoch = 1;
    await assert.rejects(f.session.adoptLearning(f.binding), /unused learning baseline/);
    f.activation.epoch = 0;
    await assert.rejects(f.session.adoptLearning({ ...f.binding, model: () => f.model }), /model identity/);
    assert.equal(await f.read(), raw);
  } finally { await f.remove(); }
});

test('adopted format refuses forged legacy provenance, missing adoption, changed policy and unknown binding before writing', async () => {
  const f = await fixture();
  try {
    await f.session.adoptLearning(f.binding); const saved = f.session.snapshot();
    const cases: Array<(value: ChessSessionCheckpoint) => void> = [
      value => { main(value).provenance.model = { id: 'forged', version: '1' }; },
      value => { delete value.learningAdoption; },
      value => { value.version = 1; },
      value => { value.learningAdoption!.initial.epoch = 1; },
      value => { value.learning = { id: 'another-journal', version: '1' }; },
      value => { value.policy.breadth++; },
    ];
    for (const change of cases) {
      const invalid = structuredClone(saved); change(invalid); await f.write(invalid); const raw = await f.read();
      await assert.rejects(f.reopen(f.binding)); assert.equal(await f.read(), raw);
    }
  } finally { await f.remove(); }
});

test('adoption retains completed-game replays and checkpoints across restart and another new game', async () => {
  const f = await fixture();
  try {
    const moves = ['f3', 'e5', 'g4', 'Qh4#'];
    f.model.decide = async request => ({ selected: moves[request.state.ply]!, confidence: 1, usage: { calls: 0 },
      preferences: request.candidates.map(plan => ({ id: plan.id, probability: plan.id === moves[request.state.ply] ? 1 : 0 })) });
    for (let i = 0; i < 4; i++) await f.session.step();
    const oldId = f.session.snapshot().mainId, oldReplay = await f.session.replay();
    await f.session.newGame(oldId); const before = f.session.snapshot();
    await f.session.adoptLearning(f.binding);
    let restored = await f.reopen(f.binding);
    assert.deepEqual(restored.snapshot().games, before.games);
    assert.deepEqual(await restored.replay(oldId), oldReplay);
    for (let i = 0; i < 4; i++) await restored.step();
    await restored.newGame(restored.snapshot().mainId); restored = await f.reopen(f.binding);
    assert.equal(restored.snapshot().games!.completed.length, 2);
    assert.deepEqual(await restored.replay(oldId), oldReplay);
    assert.equal((await restored.replayFrame(4, oldId)).world.provenance.learning, undefined);
  } finally { await f.remove(); }
});

test('lost adoption publication acknowledgment fences execution and reconnect uses the durable binding', async t => {
  const f = await fixture();
  try {
    const original = JsonFileStore.prototype.save;
    const mocked = t.mock.method(JsonFileStore.prototype, 'save', async function (this: JsonFileStore<unknown>, value: unknown) {
      await original.call(this, value);
      if ((value as ChessSessionCheckpoint).learningAdoption) throw new Error('Lost adoption acknowledgment');
    });
    await assert.rejects(f.session.adoptLearning(f.binding), /Lost adoption/);
    mocked.mock.restore();
    await assert.rejects(f.session.step(), /reconnect before continuing/);
    assert.equal(f.decisions, 0);
    const restored = await f.reopen(f.binding); await restored.step();
    assert.equal(f.decisions, 1); assert.equal(main(restored.snapshot()).state.ply, 1);
  } finally { await f.remove(); }
});

test('failed adoption publication leaves the plain session reconnectable and safe to retry', async t => {
  const f = await fixture();
  try {
    await f.session.step(); const before = await f.read();
    const original = JsonFileStore.prototype.save;
    const mocked = t.mock.method(JsonFileStore.prototype, 'save', async function (this: JsonFileStore<unknown>, value: unknown) {
      if ((value as ChessSessionCheckpoint).learningAdoption) throw new Error('Publication unavailable');
      await original.call(this, value);
    });
    await assert.rejects(f.session.adoptLearning(f.binding), /Publication unavailable/);
    mocked.mock.restore(); assert.equal(await f.read(), before);
    await assert.rejects(f.session.step(), /reconnect before continuing/);
    const restored = await f.reopen(); await restored.adoptLearning(f.binding);
    assert.equal(main(restored.snapshot()).state.ply, 1);
    await restored.step(); assert.equal(f.decisions, 1);
  } finally { await f.remove(); }
});
