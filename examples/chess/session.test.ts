import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessSession } from './session.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

const fixture = async (policy = {}, fen?: string) => {
  const root = await mkdtemp(join(tmpdir(), 'chess-session-'));
  const provider = new ChessRuntimeStore(join(root, 'runtime'), fen), adapter = new ChessAdapter(), model = new ChessFixtureModel();
  return { root, provider, adapter, model, session: await ChessSession.create(root, provider, adapter, model, policy),
    reopen: () => ChessSession.restore(root, new ChessRuntimeStore(join(root, 'runtime'), fen), adapter, model),
    remove: () => rm(root, { recursive: true, force: true }) };
};
const main = (saved: ChessSessionCheckpoint) => saved.worlds.find(world => world.meta.id === saved.mainId)!;

test('existing chess game uses shared comparison, whole-state promotion, reconnect, selected replays and rollback', async () => {
  const f = await fixture();
  try {
    const original = main(f.session.snapshot()).state;
    await f.session.step();
    const compared = f.session.snapshot();
    assert.ok(compared.batch?.complete); assert.equal(compared.batch.ids.length, 2);
    assert.deepEqual(main(compared).state, original);
    const futures = compared.worlds.filter(world => world.meta.role === 'experiment');
    assert.deepEqual(futures.map(world => world.state.ply), [2, 2]);
    assert.notDeepEqual(futures[0]!.state.moves, futures[1]!.state.moves);
    assert.equal(compared.attempts.plies, 4); assert.equal(compared.points.points.length, 1);
    const chosen = futures[0]!;
    await f.session.step();
    assert.deepEqual(main(f.session.snapshot()).state, chosen.state);
    const replay = await f.session.replay();
    assert.equal(replay.missingHistory, false); assert.equal(replay.lastTick, 2);
    assert.deepEqual((await f.session.replayFrame(2)).world.state, chosen.state);
    assert.ok(replay.segments.some(segment => segment.worldId === compared.mainId));
    await f.session.detach();
    let restored = await f.reopen();
    assert.deepEqual(main(restored.snapshot()).state, chosen.state);
    assert.deepEqual(await restored.replay(), replay);
    await restored.step(); await restored.step();
    assert.equal(main(restored.snapshot()).state.ply, 4);
    const attempts = restored.snapshot().attempts.plies;
    const point = restored.snapshot().points.points[0]!;
    await restored.rollback(point.id);
    const rolledBack = restored.snapshot();
    assert.deepEqual(main(rolledBack).state, original);
    assert.equal(rolledBack.attempts.plies, attempts); assert.equal(rolledBack.attempts.rollbacks, 1);
    assert.ok(rolledBack.experiences.length >= compared.experiences.length);
    assert.equal((await restored.replay()).lastTick, 0);
    await restored.detach(); restored = await f.reopen();
    assert.equal(main(restored.snapshot()).state.ply, 0);
    await restored.step(); await restored.step(); assert.equal(main(restored.snapshot()).state.ply, 2);
  } finally { await f.remove(); }
});

test('automatic checkpoint and recording cleanup retains selected ancestry', async () => {
  const f = await fixture({ threshold: 0, checkpointEvery: 1, checkpointLimit: 2 });
  try {
    for (let i = 0; i < 6; i++) await f.session.step();
    const saved = f.session.snapshot();
    assert.equal(saved.points.points.length, 2); assert.equal(saved.points.cleanup.length, 0);
    assert.equal(saved.attempts.plies, main(saved).state.ply);
    assert.equal((await f.session.replay()).missingHistory, false);
    assert.equal((await f.session.replay()).firstTick, 0); assert.equal((await f.session.replay()).lastTick, 6);
    await f.session.detach(); assert.equal((await (await f.reopen()).replay()).frames, 7);
  } finally { await f.remove(); }
});

test('terminal states stop input dispatch while unsupported component changes refuse reconnect', async () => {
  const f = await fixture({ threshold: 0 }, '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  try {
    await f.session.step(); assert.equal(main(f.session.snapshot()).state.status, 'checkmate');
    const before = f.session.snapshot(); await f.session.step();
    assert.equal(f.session.snapshot().attempts.plies, before.attempts.plies);
    await assert.rejects(ChessSession.restore(f.root, f.provider, new ChessAdapter('b'), f.model), /components changed/);
    await assert.rejects(ChessSession.restore(f.root, f.provider, f.adapter, { ...f.model, version: { id: 'other', version: '1' }, decide: f.model.decide }), /components changed/);
  } finally { await f.remove(); }
});

test('reconnect joins an acknowledged input once and recovers an undispatched input once', async () => {
  for (const dispatched of [true, false]) {
    const f = await fixture({ threshold: 0 });
    try {
      const saved = f.session.snapshot(), world = main(saved), san = 'e4';
      saved.pendingInputs[world.meta.id] = { before: world.state, san }; saved.attempts.plies++;
      await writeFile(join(f.root, 'session.json'), JSON.stringify(saved));
      if (dispatched) await (await f.provider.connect(world.meta.id, world.identity!, new AbortController().signal)).step({ san });
      const restored = await f.reopen();
      assert.deepEqual(main(restored.snapshot()).state.moves, ['e4']); assert.equal(restored.snapshot().attempts.plies, 1);
      assert.deepEqual(restored.snapshot().pendingInputs, {});
      assert.equal((await restored.replay()).frames, 2);
      assert.deepEqual(main((await f.reopen()).snapshot()).state.moves, ['e4']);
    } finally { await f.remove(); }
  }
});

test('unjournaled runtime movement cannot be silently adopted', async () => {
  const f = await fixture({ threshold: 0 });
  try {
    const saved = f.session.snapshot(), world = main(saved);
    await (await f.provider.connect(world.meta.id, world.identity!, new AbortController().signal)).step({ san: 'e4' });
    await assert.rejects(f.reopen(), /Unjournaled/);
  } finally { await f.remove(); }
});

test('guide changes discard a pending judgment and record the instruction actually used', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-guide-'));
  const fixture = new ChessFixtureModel(), seen: string[] = [];
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const model: typeof fixture = { version: fixture.version, decide: async (request, signal) => {
    seen.push(request.objective); if (seen.length === 1) { ready(); await wait; }
    return fixture.decide(request, signal);
  } };
  try {
    const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime')), new ChessAdapter(), model, { threshold: 0 });
    const step = session.step(); await entered; await session.guide('develop pieces before attacking'); release(); await step;
    assert.deepEqual(seen, ['win by checkmate', 'develop pieces before attacking']);
    assert.equal(main(session.snapshot()).guidance, 'develop pieces before attacking');
    assert.equal(session.snapshot().attempts.plies, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pause cancels and joins a pending model call without making the session unusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-pause-'));
  const fixture = new ChessFixtureModel(); let blocked = true, ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const model: typeof fixture = { version: fixture.version, decide: async (request, signal) => {
    if (blocked) { ready(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); signal.throwIfAborted(); }
    return fixture.decide(request, signal);
  } };
  try {
    const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime')), new ChessAdapter(), model, { threshold: 0 });
    const step = session.step(); await entered; await session.pause(); await step;
    assert.equal(session.snapshot().attempts.plies, 0);
    blocked = false; await session.step(); assert.equal(session.snapshot().attempts.plies, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed partial fork cleans children and reconciles without changing the source or recreating requested IDs', async () => {
  const f = await fixture();
  try {
    const create = f.provider.createFrom.bind(f.provider); let created = 0;
    f.provider.createFrom = async (id, state) => { if (++created === 2) throw new Error('second child failed'); return create(id, state); };
    const before = main(f.session.snapshot()).state;
    await assert.rejects(f.session.step(), /second child failed/);
    const failed = f.session.snapshot(); assert.ok(failed.pendingFork);
    const restored = await f.reopen();
    assert.deepEqual(main(restored.snapshot()).state, before);
    assert.equal(restored.snapshot().pendingFork, undefined); assert.equal(restored.snapshot().batch, undefined);
    for (const id of failed.pendingFork.ids) assert.equal(await f.provider.recover(id), undefined);
    await restored.step(); assert.ok(restored.snapshot().batch?.complete);
    assert.ok(restored.snapshot().batch!.ids.every(id => !failed.pendingFork!.ids.includes(id)));
  } finally { await f.remove(); }
});

test('tampered execution checkpoints fail validation before replacing the source', async () => {
  const f = await fixture();
  try {
    const id = await f.session.checkpoint(), before = main(f.session.snapshot()).state;
    const directory = join(f.root, 'runtime', 'checkpoints'), files = await readdir(directory);
    const path = join(directory, files[0]!), point = JSON.parse(await readFile(path, 'utf8'));
    point.state.fen = 'tampered'; await writeFile(path, JSON.stringify(point));
    await assert.rejects(f.session.rollback(id), /history does not match/);
    assert.deepEqual(main(f.session.snapshot()).state, before);
    await assert.rejects(f.session.step(), /pending operations/);
  } finally { await f.remove(); }
});

test('discarded futures contribute measured multi-ply feedback at the original decision state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-feedback-'));
  const fen = '3r2k1/8/8/3r4/8/8/8/3Q2K1 w - - 0 1';
  const fixture = new ChessFixtureModel(); let feedbackSeen = false;
  const model: typeof fixture = { version: fixture.version, decide: async (request, signal) => {
    if (request.state.fen !== fen) return fixture.decide(request, signal);
    feedbackSeen ||= request.experience.some(record => record.action === 'Qxd5+' && record.result < 0 && record.plies === 2);
    return { selected: 'Qxd5+', confidence: .4, usage: { calls: 0 }, preferences: request.candidates.map(plan => ({ id: plan.id, probability: plan.id === 'Qxd5+' ? .6 : plan.id === 'Kh2' ? .4 : 0 })) };
  } };
  try {
    const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime'), fen), new ChessAdapter(), model);
    await session.step();
    const explored = session.snapshot();
    assert.ok(explored.experiences.some(record => record.action === 'Qxd5+' && record.plies === 2 && record.result === -4));
    await session.step(); assert.equal(main(session.snapshot()).state.moves[0], 'Kh2');
    const count = session.snapshot().experiences.length;
    await session.rollback(explored.points.points[0]!.id);
    assert.equal(session.snapshot().experiences.length, count);
    await session.step(); assert.equal(feedbackSeen, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a changed guide during fork creation attributes trial feedback to the actual replacement opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-fork-guide-'));
  const provider = new ChessRuntimeStore(join(root, 'runtime')), fixture = new ChessFixtureModel();
  let entered!: () => void, release!: () => void, first = true;
  const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const create = provider.createFrom.bind(provider);
  const model: typeof fixture = { version: fixture.version, decide: async (request, signal) => {
    if (request.state.ply !== 0 || request.objective !== 'prefer e4') return fixture.decide(request, signal);
    return { selected: 'e4', confidence: .4, usage: { calls: 0 }, preferences: request.candidates.map(plan => ({ id: plan.id, probability: plan.id === 'e4' ? 1 : 0 })) };
  } };
  try {
    const session = await ChessSession.create(root, provider, new ChessAdapter(), model);
    provider.createFrom = async (id, state) => { if (first) { first = false; entered(); await wait; } return create(id, state); };
    const step = session.step(); await ready; await session.guide('prefer e4'); release(); await step;
    const snapshot = session.snapshot();
    for (const id of snapshot.batch!.ids) {
      const world = snapshot.worlds.find(world => world.meta.id === id)!;
      assert.equal(world.state.moves[0], 'e4'); assert.equal(world.label, 'e4');
      const trial = snapshot.experiences.find(record => record.worldId === id && record.plies === 2)!;
      assert.equal(trial.action, 'e4');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
