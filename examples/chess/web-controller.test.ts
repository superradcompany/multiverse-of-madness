import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessWebController } from './web-controller.ts';

async function fixture(model = new ChessFixtureModel()) {
  const directory = await mkdtemp(join(tmpdir(), 'chess-web-'));
  const provider = new ChessRuntimeStore(join(directory, 'runtime')), adapter = new ChessAdapter();
  const session = await ChessSession.create(directory, provider, adapter, model);
  return { directory, session, web: new ChessWebController(session, 5), provider, adapter, model };
}

test('web controls preserve comparison, selected path and checkpoint restoration across reconnect', async () => {
  const f = await fixture();
  try {
    await f.web.step();
    const compared = f.web.view();
    assert.equal(compared.comparison?.complete, true); assert.equal(compared.worlds.length, 3);
    assert.equal(compared.worlds.find(world => world.id === compared.mainId)!.state.ply, 0);
    await f.web.step();
    const promoted = f.web.view();
    assert.notEqual(promoted.mainId, compared.mainId);
    assert.equal(promoted.worlds.length, 1);
    assert.equal((await f.session.replayFrame(2)).world.state.ply, 2);
    await f.web.close();
    const restored = await ChessSession.restore(f.directory, f.provider, f.adapter, f.model), web = new ChessWebController(restored);
    assert.deepEqual(web.view(), promoted);
    await web.rollback(web.view().checkpoints[0]!.id);
    assert.equal(web.view().worlds[0]!.state.ply, 0);
    assert.equal(web.view().attempts.plies, promoted.attempts.plies);
    assert.equal(web.view().attempts.rollbacks, 1);
    assert.equal((await restored.replayFrame(2, promoted.mainId)).world.state.ply, 2);
    await assert.rejects(restored.replayFrame(0, 'unknown-world'));
    await web.close();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('pause joins an in-flight decision and concurrent commands cannot race it', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = new ChessFixtureModel();
  model.decide = async (_request, signal) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const f = await fixture(model);
  try {
    const step = f.web.step(); await started;
    assert.equal(f.web.view().busy, true);
    await assert.rejects(f.web.step(), /Pause playback/);
    await assert.rejects(f.web.guide('different goal'), /Pause playback/);
    await f.web.pause(); await step;
    assert.equal(f.web.view().busy, false); assert.equal(f.web.view().error, undefined);
    await f.web.close();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('automatic play advances independently of viewers and stays stopped after pause', async () => {
  const f = await fixture();
  try {
    f.web.play(); assert.throws(() => f.web.play(), /Pause playback/);
    const deadline = Date.now() + 3000;
    while (f.web.view().attempts.plies < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await f.web.pause();
    assert.ok(f.web.view().attempts.plies >= 4);
    const paused = f.web.view(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(f.web.view(), paused);
    await f.web.close();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('scheduled gameplay waits for revision publication without racing or stopping the run', async () => {
  const f = await fixture(); let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  try {
    f.web.play();
    const boundary = f.web.learningBoundary(async () => { await wait; return 'published'; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.web.view().busy, true); assert.equal(f.web.view().running, true);
    assert.equal(f.web.view().attempts.plies, 0); assert.equal(f.web.view().error, undefined);
    release(); assert.equal(await boundary, 'published');
    const deadline = Date.now() + 3000;
    while (f.web.view().attempts.plies < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await f.web.pause(); assert.ok(f.web.view().attempts.plies >= 2); assert.equal(f.web.view().error, undefined);
  } finally { release(); await f.web.close(); await rm(f.directory, { recursive: true, force: true }); }
});
