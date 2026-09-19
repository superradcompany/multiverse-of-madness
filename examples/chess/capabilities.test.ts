import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnsupportedGameCapabilities, type GameCapabilities } from '@multiverse/gameplay-harness';
import { ChessWorld, chessWorldCapabilities } from './runtime.ts';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessSession } from './session.ts';
import { decideChess } from './decision.ts';
import type { ChessDecisionRequest } from './preparation.ts';

async function request(): Promise<ChessDecisionRequest> {
  const state = await new ChessWorld('capability-test').state();
  return { state, objective: 'win', candidates: await new ChessAdapter().candidates(state), experience: [], revision: { id: 'fixture', version: '1' } };
}

test('in-memory chess refuses a durable-checkpoint plan before preparation or model calls', async () => {
  const input = await request(); input.candidates[0]!.requires = ['checkpoint'];
  let preparations = 0, decisions = 0;
  const fixture = new ChessFixtureModel();
  await assert.rejects(decideChess({ version: fixture.version,
    prepare: async value => { preparations++; return value; },
    decide: async (value, signal) => { decisions++; return fixture.decide(value, signal); },
  }, input, new AbortController().signal, chessWorldCapabilities), UnsupportedGameCapabilities);
  assert.equal(preparations, 0); assert.equal(decisions, 0);
  const provider = new ChessRuntimeStore('unused-capability-fixture');
  assert.deepEqual({ ...provider.capabilities, checkpoint: false, restore: false, detached: false }, chessWorldCapabilities);
  const result = await decideChess(fixture, input, new AbortController().signal, provider.capabilities);
  assert.ok(input.candidates.some(plan => plan.id === result.answer.selected));
});

test('capability loss during preparation is checked before the model receives the menu', async () => {
  const input = await request(); input.candidates[0]!.requires = ['render'];
  const capabilities: GameCapabilities = { ...chessWorldCapabilities };
  await assert.rejects(decideChess({ version: { id: 'fixture', version: '1' },
    prepare: async value => { capabilities.render = false; return value; },
    decide: async () => assert.fail('Do not dispatch the decision'),
  }, input, new AbortController().signal, capabilities), UnsupportedGameCapabilities);
});

test('session rechecks a selected plan before input publication when capabilities change during a decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-capability-'));
  try {
    const provider = new ChessRuntimeStore(join(directory, 'runtime')), adapter = new ChessAdapter(), fixture = new ChessFixtureModel();
    const capabilities: GameCapabilities = { ...provider.capabilities };
    Object.defineProperty(provider, 'capabilities', { value: capabilities });
    const candidates = adapter.candidates.bind(adapter);
    adapter.candidates = async state => (await candidates(state)).map(plan => ({ ...plan, requires: ['render'] }));
    const session = await ChessSession.create(directory, provider, adapter, { version: fixture.version,
      decide: async (value, signal) => { const answer = await fixture.decide(value, signal); capabilities.render = false; return answer; },
    }, { threshold: 0 });
    const before = session.snapshot();
    await assert.rejects(session.step(), UnsupportedGameCapabilities);
    const after = session.snapshot();
    assert.deepEqual(after.pendingInputs, {}); assert.equal(after.attempts.plies, 0);
    assert.deepEqual(after.worlds[0]!.state, before.worlds[0]!.state);
    assert.equal((await session.replay()).lastTick, 0);
    const world = after.worlds[0]!;
    assert.deepEqual(await (await provider.connect(world.meta.id, world.identity!, new AbortController().signal)).state(), world.state);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capability loss during a low-confidence decision refuses the batch before fork allocation or intent publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-fork-capability-'));
  try {
    const provider = new ChessRuntimeStore(join(directory, 'runtime')), adapter = new ChessAdapter(), fixture = new ChessFixtureModel();
    const capabilities: GameCapabilities = { ...provider.capabilities };
    Object.defineProperty(provider, 'capabilities', { value: capabilities });
    const candidates = adapter.candidates.bind(adapter);
    adapter.candidates = async state => (await candidates(state)).map(plan => ({ ...plan, requires: ['render'] }));
    let creations = 0;
    const create = provider.createFrom.bind(provider);
    provider.createFrom = async (...args) => { creations++; return create(...args); };
    const session = await ChessSession.create(directory, provider, adapter, { version: fixture.version,
      decide: async (value, signal) => { const answer = await fixture.decide(value, signal); capabilities.render = false; return answer; },
    }, { threshold: 1 });
    await assert.rejects(session.step(), UnsupportedGameCapabilities);
    const after = session.snapshot();
    assert.equal(creations, 1); assert.equal(after.pendingFork, undefined); assert.equal(after.batch, undefined);
    assert.equal(after.attempts.forks, 0); assert.equal(after.attempts.plies, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restored futures recheck stored opening requirements before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-restored-capability-'));
  try {
    const provider = new ChessRuntimeStore(join(directory, 'runtime')), adapter = new ChessAdapter(), model = new ChessFixtureModel();
    const candidates = adapter.candidates.bind(adapter);
    adapter.candidates = async state => (await candidates(state)).map(plan => ({ ...plan, requires: ['restore'] }));
    const session = await ChessSession.create(directory, provider, adapter, model, { threshold: 1 });
    let paused: Promise<void> | undefined;
    const create = provider.createFrom.bind(provider);
    provider.createFrom = async (...args) => {
      const world = await create(...args);
      // Interrupt after allocation; durable fork attachment still finishes, leaving unexecuted openings.
      paused ??= session.pause(); return world;
    };
    await session.step(); await paused; await session.detach();
    const saved = session.snapshot();
    assert.equal(saved.batch?.complete, false); assert.equal(saved.attempts.plies, 0);
    assert.ok(saved.worlds.some(world => world.opening?.requires.includes('restore')));
    const limited = new ChessRuntimeStore(join(directory, 'runtime'));
    Object.defineProperty(limited, 'capabilities', { value: { ...limited.capabilities, restore: false } });
    const restored = await ChessSession.restore(directory, limited, adapter, model);
    await assert.rejects(restored.step(), UnsupportedGameCapabilities);
    assert.equal(restored.snapshot().attempts.plies, 0); assert.deepEqual(restored.snapshot().pendingInputs, {});
    for (const world of restored.snapshot().worlds) assert.equal(world.state.ply, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
