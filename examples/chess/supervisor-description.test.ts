import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutableStore, contentRevision } from '@multiverse/gameplay-harness/node';
import type { ExecutableSource, SupervisorProvider } from '@multiverse/gameplay-harness';
import { generateChessRevision, type ChessTrainingEvidence } from '../../scripts/qualification/supervisor-proposal.ts';
import { ChessAdapter } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessWorld } from './runtime.ts';
import { describeChess } from './description.ts';
import { defaultChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';

test('actual proposal path supplies mechanics and training evidence without private acceptance data or host execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-supervisor-description-'));
  try {
    const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter(), runtime = new ChessRuntimeStore(join(directory, 'runtime'));
    const source: ExecutableSource = { format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'export default input => input.candidates[0]' } };
    const executable = await store.put(source);
    const fields = { adapter: adapter.version, model: { id: 'test', version: '1' }, policy: defaultChessPolicy, executor: executable.revision, prompts: {}, skills: [] };
    const current = { ...fields, revision: contentRevision('chess-learning', fields) }, active = { epoch: 0, revision: current.revision };
    const game = describeChess(adapter.version, runtime.capabilities);
    const world = new ChessWorld('training'), before = await world.state(), after = await world.step({ san: 'e4' });
    const observations = [{ before, selected: 'e4', after }];
    let calls = 0;
    const proposed: ExecutableSource = { ...source, files: { 'main.ts': 'throw new Error("must not run on host"); export default input => input.candidates[0];' } };
    const provider: SupervisorProvider<ChessPolicy, ChessTrainingEvidence> = {
      version: { id: 'recording-test-provider', version: '1' },
      async propose(request) {
        calls++;
        assert.deepEqual(request.evidence.game, game);
        assert.deepEqual(request.evidence.observations, observations);
        assert.deepEqual(Object.keys(request.evidence).sort(), ['currentSource', 'game', 'observations']);
        assert.deepEqual(request.contract, { id: 'private-test-contract', version: '1' });
        assert.match(request.task, /host-authored description/);
        return { draft: { reason: 'A test proposal', source: proposed }, receipt: { id: request.id, provider: this.version, startedAt: Date.now(), elapsedMs: 1, inputBytes: 1, outputBytes: 1, status: 'complete', requestedModel: 'fixture', servingModels: ['fixture'], usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 } } };
      },
    };
    const options = { directory, controller: { current, active }, context: { id: 'context', version: '1' }, contract: { id: 'private-test-contract', version: '1' }, store, observations, game, provider };
    const result = await generateChessRevision(options, new AbortController().signal);
    assert.deepEqual((await store.get(result.artifact.executor)).source, proposed);
    assert.deepEqual(options.controller.active, active); // Generation alone does not activate.
    await assert.rejects(generateChessRevision({ ...options, game: { ...game, adapter: { id: 'wrong', version: '1' } } }, new AbortController().signal), /does not match/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
