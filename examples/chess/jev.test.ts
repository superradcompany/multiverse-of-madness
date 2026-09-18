import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { ChessAdapter } from './adapter.ts';
import { ChessWorld } from './runtime.ts';
import { ChessJevModel, chessQuestion } from './jev.ts';

const request = async () => {
  const state = await new ChessWorld('request', { initialFen: '3r2k1/8/8/3r4/8/8/8/3Q2K1 w - - 0 1', moves: [] }).state();
  return { state, objective: 'preserve the queen', candidates: await new ChessAdapter().candidates(state),
    experience: [{ worldId: 'discarded', action: 'Qxd5+', fen: state.fen, afterFen: 'observed-result', result: -4, plies: 2 }], revision: { id: 'policy', version: '1' } };
};
const signal = () => new AbortController().signal;

test('Jev receives current board, user guide and full-trial feedback, records serving model and caps calls across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-jev-'));
  let calls = 0, wire: any;
  const client = new TypeSafeClient({ apiKey: 'test-secret-not-for-recordings', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
    calls++; wire = JSON.parse(String(init?.body));
    const selected = Object.keys(wire.questions.move.criteria).find(key => wire.questions.move.criteria[key].startsWith('Kh2:'))!;
    return new Response(JSON.stringify({ model: 'jev-test-serving-version', answers: { move: { type: 'choice', choice: selected, confidence: .82,
      probabilities: Object.fromEntries(Object.keys(wire.questions.move.criteria).map(key => [key, key === selected ? 1 : 0])) } }, usage: { input_tokens: 410, output_tokens: 50 } }));
  } });
  try {
    const provider = await ChessJevModel.open(root, { model: 'jev-test', maxCalls: 1 }, client);
    const result = await provider.decide(await request(), signal());
    assert.equal(result.selected, 'Kh2'); assert.equal(result.usage.inputTokens, 410);
    assert.equal(wire.state.userObjective, 'preserve the queen'); assert.equal(wire.state.sideToMove, 'w');
    assert.equal(wire.state.relatedAttempts[0].plies, 2); assert.equal(wire.state.relatedAttempts[0].result, -4);
    assert.ok(wire.state.pieces.includes('w:queen:d1')); assert.equal(wire.model, 'jev-test');
    assert.match(wire.questions.move.instructions.guide, /opponent turn, play competitively/);
    const files = await readdir(join(root, 'decisions')), raw = await readFile(join(root, 'decisions', files[0]!), 'utf8'), recorded = JSON.parse(raw);
    assert.equal(recorded.status, 'complete'); assert.equal(recorded.response.model, 'jev-test-serving-version');
    assert.equal(raw.includes('test-secret-not-for-recordings'), false);
    const restored = await ChessJevModel.open(root, undefined, client);
    assert.deepEqual(restored.version, provider.version);
    assert.equal(restored.budget().entries[0]?.usage?.inputTokens, 410);
    await assert.rejects(restored.decide(await request(), signal()), /Budget exhausted/);
    assert.equal(calls, 1);
    await assert.rejects(ChessJevModel.open(root, { maxCalls: 2 }, client), /pinned/);
    await rm(join(root, 'budget.json'));
    await assert.rejects(ChessJevModel.open(root, undefined, client), /Incomplete Jev/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Jev rejects unavailable moves and malformed distributions while retaining consumed call reservations', async () => {
  for (const invalid of ['unknown-choice', 'bad-distribution']) {
    const root = await mkdtemp(join(tmpdir(), 'chess-jev-invalid-'));
    const client = new TypeSafeClient({ apiKey: 'test-key', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), keys = Object.keys(wire.questions.move.criteria);
      return new Response(JSON.stringify({ model: 'test', answers: { move: { type: 'choice', choice: invalid === 'unknown-choice' ? 'invented' : keys[0], confidence: .5,
        probabilities: Object.fromEntries(keys.map(key => [key, invalid === 'bad-distribution' ? .5 : key === keys[0] ? 1 : 0])) } }, usage: { input_tokens: 10, output_tokens: 2 } }));
    } });
    try {
      const provider = await ChessJevModel.open(root, { maxCalls: 1 }, client);
      await assert.rejects(provider.decide(await request(), signal()), /Invalid chess Jev response/);
      assert.equal(provider.budget().entries[0]?.status, 'failed');
      assert.equal(provider.budget().entries[0]?.usage?.modelCalls, 1);
      await assert.rejects((await ChessJevModel.open(root, undefined, client)).decide(await request(), signal()), /Budget exhausted/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('cancelled requests and illegal candidate plans cannot dispatch model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-jev-cancel-'));
  let calls = 0;
  const client = new TypeSafeClient({ apiKey: 'test-key', fetch: async () => { calls++; throw new Error('Unexpected dispatch'); } });
  try {
    const provider = await ChessJevModel.open(root, {}, client), control = new AbortController(); control.abort();
    await assert.rejects(provider.decide(await request(), control.signal));
    const invalid = await request(); invalid.candidates[0]!.payload.san = 'illegal';
    await assert.rejects(provider.decide(invalid, signal()), /legal candidates/);
    assert.equal(calls, 0); assert.equal(provider.budget().entries.length, 0);
    const black = await request(); black.state = await new ChessWorld('black', { initialFen: '3r2k1/8/8/3r4/8/8/8/3Q2K1 b - - 0 1', moves: [] }).state();
    black.candidates = await new ChessAdapter().candidates(black.state);
    assert.equal((chessQuestion(black, provider.config).state as { sideToMove: string }).sideToMove, 'b');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rounded real-world probability totals are normalized while raw evidence remains unchanged', async () => {
  for (const total of [.99, 1.01]) {
    const root = await mkdtemp(join(tmpdir(), 'chess-jev-rounded-'));
    const client = new TypeSafeClient({ apiKey: 'test-key', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), keys = Object.keys(wire.questions.move.criteria);
      return new Response(JSON.stringify({ model: 'test', answers: { move: { type: 'choice', choice: keys[0], confidence: .53,
        probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? .57 : i === 1 ? total - .57 : 0])) } }, usage: { input_tokens: 1296, output_tokens: 189 } }));
    } });
    try {
      const provider = await ChessJevModel.open(root, {}, client), result = await provider.decide(await request(), signal());
      assert.ok(Math.abs(result.preferences.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-10);
      const file = (await readdir(join(root, 'decisions')))[0]!;
      const receipt = JSON.parse(await readFile(join(root, 'decisions', file), 'utf8'));
      assert.equal(receipt.response.answers.move.probabilities.m0, .57);
      assert.equal(receipt.status, 'complete');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('new chess models have no lifetime call cap and preserve accounting across reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-jev-unlimited-'));
  try {
    const client = new TypeSafeClient({ apiKey: 'test-key', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), keys = Object.keys(wire.questions.move.criteria);
      return new Response(JSON.stringify({ model: 'test', answers: { move: { type: 'choice', choice: keys[0], confidence: .8,
        probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])) } }, usage: { input_tokens: 10, output_tokens: 2 } }));
    } });
    const model = await ChessJevModel.open(root, {}, client), input = await request();
    assert.equal(model.config.maxCalls, null);
    for (let i = 0; i < 65; i++) await model.decide(input, signal());
    assert.equal(model.budget().entries.length, 65);
    const restored = await ChessJevModel.open(root, {}, client);
    assert.deepEqual(restored.version, model.version);
    assert.deepEqual(restored.budget(), model.budget());
  } finally { await rm(root, { recursive: true, force: true }); }
});
