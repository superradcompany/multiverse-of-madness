import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RevisionController, type CheckpointStore, type AutonomousLearningState, type RevisionJournal, type LearningRevision } from '@multiverse/gameplay-harness';
import { ChessAutomaticLearning, type ChessAutomaticMark } from './automatic-learning.ts';
import type { ChessLearningJobJournal } from './learning-jobs.ts';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessWorld } from './runtime.ts';
import { defaultChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';
function store<T>(): CheckpointStore<T> {
  let value: T | undefined;
  return { load: async () => structuredClone(value), save: async next => { value = structuredClone(next); }, flush: async () => {} };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// These tests inject generation/qualification results; they verify background ownership, not AI quality.
test('automatic chess work freezes evidence, stays off the play path, and activates only at a natural boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-auto-'));
  let owner: ChessAutomaticLearning | undefined;
  const release = deferred();
  try {
    const session = await ChessSession.create(root, new ChessRuntimeStore(join(root, 'runtime')), new ChessAdapter(), new ChessFixtureModel());
    const snapshot = session.snapshot(); await session.detach();
    const world = new ChessWorld('evidence');
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) await world.step({ san });
    snapshot.worlds[0]!.state = await world.state(); snapshot.attempts.plies = 4; await world.destroy();
    const baseline: LearningRevision<ChessPolicy> = { revision: { id: 'strategy', version: '0' }, policy: defaultChessPolicy, prompts: {}, skills: [],
      executor: { id: 'executor', version: '0' }, model: { id: 'model', version: '1' }, adapter: new ChessAdapter().version };
    const candidate = { ...baseline, revision: { id: 'strategy', version: '1' }, executor: { id: 'executor', version: '1' } };
    const journal = store<RevisionJournal<ChessPolicy>>(), state = store<AutonomousLearningState<ChessAutomaticMark>>(), jobs = store<ChessLearningJobJournal>();
    const context = { id: 'context', version: '1' }, rules = { contract: { id: 'fixture-qualification', version: '1' }, capabilities: ['executor' as const], maxLifetimeMs: 60000 };
    const controller = await RevisionController.create(baseline, rules, { context: () => context, boundary: async work => work(), verify: async () => {}, compatible: async () => {}, persist: value => journal.save(value),
      qualify: async request => ({ baseline: request.baseline.revision, candidate: request.candidate.revision, contract: request.contract, context: request.context, accepted: true, reason: 'Fixture evidence', evidence: {} }),
    });
    let ready = true, auditPending = true, proposals = 0, now = 1000000; let captured: ChessAutomaticMark | undefined;
    const options = { binding: { id: 'binding', version: '1' }, controller, state, jobs, snapshot: () => structuredClone(snapshot), context: () => context,
      ready: () => ready, recover: async () => {}, settled: async () => {}, bootstrap: true, now: () => now,
      beforeReview: async () => auditPending,
      propose: async (id: string, mark: ChessAutomaticMark) => {
        proposals++; captured = structuredClone(mark); await release.promise;
        await controller.submit({ id, candidate, reason: mark.evidence.reason, expected: mark.origin, expiresAt: Date.now() + 60000 });
        // A lost receipt after submission must not trigger a second paid generation.
        throw new Error('generation acknowledgment lost');
      },
    };
    owner = await ChessAutomaticLearning.open(options);
    await owner.tick(); assert.equal(proposals, 0); assert.equal(owner.snapshot().cycle, undefined);
    auditPending = false;
    await owner.tick(); assert.ok(owner.snapshot().cycle); // Admission returns before the provider settles.
    await new Promise(resolve => setImmediate(resolve)); assert.equal(proposals, 1);
    snapshot.attempts.plies = 6;
    await owner.tick(); assert.equal(proposals, 1); assert.equal(captured!.evidence.mark.attemptedPlies, 4);
    assert.equal(captured!.evidence.observations.length, 4);
    release.resolve(); await owner.joinJobs(); await owner.tick(); await owner.joinJobs();
    ready = false; await owner.tick(); assert.equal(controller.active.epoch, 0);
    ready = true; await owner.tick(); assert.equal(controller.active.epoch, 1);
    assert.equal(owner.snapshot().lastOutcome?.status, 'activated');
    await owner.close(); owner = await ChessAutomaticLearning.open(options);
    now += 1000000; await owner.tick(); assert.equal(proposals, 1); assert.equal(owner.snapshot().cycle, undefined);
  } finally { release.resolve(); await owner?.close(); await rm(root, { recursive: true, force: true }); }
});
