import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POSITION } from 'chess.js';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessSession } from './session.ts';
import { ChessWebController } from './web-controller.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chess-new-game-'));
  const provider = new ChessRuntimeStore(join(root, 'runtime')), adapter = new ChessAdapter(), model = new ChessFixtureModel();
  // Scripted legal game for lifecycle qualification; not a playing-strength claim.
  model.decide = async request => ({ selected: ['f3', 'e5', 'g4', 'Qh4#'][request.state.ply]!,
    confidence: 1, preferences: request.candidates.map(plan => ({ id: plan.id, probability: plan.id === ['f3', 'e5', 'g4', 'Qh4#'][request.state.ply] ? 1 : 0 })), usage: { calls: 0 } });
  const session = await ChessSession.create(root, provider, adapter, model, { threshold: 0 });
  const reopen = () => ChessSession.restore(root, new ChessRuntimeStore(join(root, 'runtime')), adapter, model);
  return { root, provider, adapter, model, session, reopen, remove: () => rm(root, { recursive: true, force: true }) };
}
async function finish(session: ChessSession) { for (let i = 0; i < 4; i++) await session.step(); }
const main = (saved: ChessSessionCheckpoint) => saved.worlds.find(world => world.meta.id === saved.mainId)!;

test('finished game starts fresh, retains replay and goal, resets current counters, and survives reconnect', async () => {
  const f = await fixture();
  try {
    const web = new ChessWebController(f.session);
    await assert.rejects(web.newGame(web.view().mainId), /Only the current finished/);
    assert.equal(web.view().error, undefined);
    await f.session.guide('develop my pieces'); await finish(f.session);
    const before = f.session.snapshot(), context = f.session.supervisorContext(), replay = await f.session.replay();
    assert.equal(main(before).state.status, 'checkmate');
    await web.newGame(before.mainId);
    const after = f.session.snapshot(), view = web.view();
    assert.equal(after.version, 2); assert.equal(main(after).state.fen, DEFAULT_POSITION);
    assert.equal(main(after).state.ply, 0); assert.equal(after.objective, before.objective);
    assert.deepEqual(main(after).provenance, main(before).provenance);
    assert.notDeepEqual(f.session.supervisorContext(), context);
    assert.equal(after.points.points.length, 0); assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(view.attempts, { plies: 0, decisions: 0, forks: 0, rollbacks: 0 });
    assert.equal(view.completedGames.length, 1); assert.equal(view.running, false);
    assert.equal(await f.provider.recover(before.mainId), undefined);
    assert.equal((await f.session.replay()).frames, 1);
    assert.deepEqual(await f.session.replay(before.mainId), replay);
    assert.deepEqual((await f.session.replayFrame(4, before.mainId)).world.state, main(before).state);
    await assert.rejects(web.newGame(before.mainId), /Only the current finished/);
    assert.equal(web.view().error, undefined);
    await web.close(); const restored = await f.reopen();
    assert.deepEqual(restored.snapshot(), after);
    assert.deepEqual((await restored.replayFrame(4, before.mainId)).world.state, main(before).state);
    await restored.step(); assert.equal(main(restored.snapshot()).state.ply, 1);
    await restored.detach();
  } finally { await f.remove(); }
});

test('interrupted new-game allocation recovers once before exposing the fresh board', async () => {
  for (const allocated of [false, true]) {
    const f = await fixture();
    try {
      await finish(f.session); await f.session.detach();
      const saved = f.session.snapshot(); saved.version = 2;
      saved.pendingNewGame = { id: 'interrupted-root', previousMainId: saved.mainId, createdAt: 1234 };
      await writeFile(join(f.root, 'session.json'), JSON.stringify(saved));
      if (allocated) await f.provider.createFrom('interrupted-root', { initialFen: DEFAULT_POSITION, moves: [] });
      const recovered = await f.reopen(), after = recovered.snapshot();
      assert.equal(after.mainId, 'interrupted-root'); assert.equal(after.pendingNewGame, undefined);
      assert.equal(after.games?.completed.length, 1); assert.equal(after.games?.completed[0]?.endpointId, saved.mainId);
      assert.equal(main(after).state.fen, DEFAULT_POSITION);
      await recovered.detach(); assert.deepEqual((await f.reopen()).snapshot(), after);
      assert.deepEqual((await recovered.replayFrame(4, saved.mainId)).world.state, main(saved).state);
    } finally { await f.remove(); }
  }
});

test('old completed replay stays accessible after archived world metadata is collected', async () => {
  const f = await fixture();
  try {
    await finish(f.session); const first = f.session.snapshot(); await f.session.newGame(first.mainId);
    for (let i = 0; i < 21; i++) { await finish(f.session); await f.session.newGame(f.session.snapshot().mainId); }
    const saved = f.session.snapshot();
    assert.equal(saved.worlds.some(world => world.meta.id === first.mainId), false);
    assert.equal(saved.games?.completed.length, 22);
    assert.deepEqual((await f.session.replayFrame(4, first.mainId)).world.state, main(first).state);
    await f.session.detach(); const restored = await f.reopen();
    assert.deepEqual((await restored.replayFrame(4, first.mainId)).world.state, main(first).state);
  } finally { await f.remove(); }
});

test('recovery refuses a moved replacement root without discarding the finished game', async () => {
  const f = await fixture();
  try {
    await finish(f.session); await f.session.detach(); const saved = f.session.snapshot();
    saved.version = 2; saved.pendingNewGame = { id: 'changed-root', previousMainId: saved.mainId, createdAt: 1 };
    await f.provider.createFrom('changed-root', { initialFen: DEFAULT_POSITION, moves: ['e4'] });
    await writeFile(join(f.root, 'session.json'), JSON.stringify(saved));
    await assert.rejects(f.reopen(), /not the initial board/);
    assert.equal(await readFile(join(f.root, 'session.json'), 'utf8'), JSON.stringify(saved));
    assert.deepEqual(await (await f.provider.recover(saved.mainId))!.state(), main(saved).state);
  } finally { await f.remove(); }
});

test('failed new-game publication keeps the old game authoritative and reconnect finishes the saved intent', async () => {
  const f = await fixture();
  try {
    await finish(f.session); const before = f.session.snapshot();
    const store = (f.session as unknown as { store: { save(value: ChessSessionCheckpoint): Promise<void> } }).store;
    const save = store.save.bind(store); let failPublication = true;
    store.save = async value => {
      if (value.games && failPublication) { failPublication = false; throw new Error('injected publication failure'); }
      await save(value);
    };
    await assert.rejects(f.session.newGame(before.mainId), /injected publication/);
    assert.equal(f.session.snapshot().mainId, before.mainId); assert.equal(f.session.snapshot().games, undefined);
    assert.ok(f.session.snapshot().pendingNewGame);
    assert.deepEqual(await (await f.provider.recover(before.mainId))!.state(), main(before).state);
    await f.session.detach(); const restored = await f.reopen();
    assert.equal(restored.snapshot().games?.completed.length, 1);
    assert.equal(main(restored.snapshot()).state.fen, DEFAULT_POSITION);
    assert.deepEqual((await restored.replayFrame(4, before.mainId)).world.state, main(before).state);
  } finally { await f.remove(); }
});
