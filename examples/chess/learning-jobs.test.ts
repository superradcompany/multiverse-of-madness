import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChessLearningJobs, type ChessLearningJobJournal } from './learning-jobs.ts';
const binding = { id: 'learning', version: 'test' };
function fixture() {
  let data: ChessLearningJobJournal | undefined;
  return { get data() { return structuredClone(data); }, store: { flush: async () => {}, load: async () => structuredClone(data), save: async (value: ChessLearningJobJournal) => { data = structuredClone(value); } } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('job admission is durable and idempotent through concurrent requests and authoritative reopen', async () => {
  const f = fixture(), running = deferred(), release = deferred(); let calls = 0;
  const ports = { binding, store: f.store, recover: async () => {}, settled: async () => {}, execute: async () => {
    calls++; assert.equal(f.data!.jobs[0]!.status, 'running'); running.resolve(); await release.promise;
  } };
  const jobs = await ChessLearningJobs.open(ports), command = { kind: 'propose' as const, id: randomUUID() };
  await Promise.all([jobs.start(command), jobs.start(command)]); await running.promise;
  assert.equal(calls, 1); assert.equal(jobs.busy, true);
  await assert.rejects(jobs.start({ ...command, id: randomUUID() }), /Another/);
  await assert.rejects(jobs.start({ kind: 'evaluate', id: command.id, proposalId: randomUUID() }), /identity reused/);
  release.resolve(); await jobs.join(); assert.equal(f.data!.jobs[0]!.status, 'complete');
  await jobs.close(); const reopened = await ChessLearningJobs.open(ports);
  await reopened.start(command); await reopened.join(); assert.equal(calls, 1); await reopened.close();
});

test('interrupted requests recover owned resources and never regenerate paid work', async () => {
  const f = fixture(), id = randomUUID(); let recovered = false;
  await f.store.save({ version: 1, binding, jobs: [{ command: { kind: 'propose', id }, status: 'running', createdAt: 1, updatedAt: 2 }] });
  const jobs = await ChessLearningJobs.open({ binding, store: f.store, recover: async () => { recovered = true; }, settled: async () => {}, execute: async () => assert.fail('must not regenerate') });
  assert.equal(recovered, true); assert.equal((await jobs.start({ kind: 'propose', id })).status, 'interrupted'); await jobs.close();
});

test('cancellation joins execution and cleanup; failed publication prevents dispatch', async () => {
  const f = fixture(), running = deferred(), cleanup = deferred(); let cleaned = false;
  const jobs = await ChessLearningJobs.open({ binding, store: f.store, recover: async () => {}, settled: async () => { await cleanup.promise; cleaned = true; },
    execute: async (_command, signal) => { running.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  });
  const id = randomUUID(); await jobs.start({ kind: 'propose', id }); await running.promise;
  const cancelled = jobs.cancel(id); assert.equal(jobs.busy, true); assert.equal(cleaned, false);
  cleanup.resolve(); await cancelled; assert.equal(cleaned, true); assert.equal(f.data!.jobs[0]!.status, 'cancelled'); await jobs.close();
  let writes = 0;
  const failed = await ChessLearningJobs.open({ binding, store: { flush: async () => {}, load: async () => undefined, save: async () => { if (++writes > 1) throw new Error('disk failed'); } },
    recover: async () => {}, settled: async () => {}, execute: async () => assert.fail('no paid dispatch before durable admission') });
  await assert.rejects(failed.start({ kind: 'propose', id: randomUUID() }), /disk failed/);
  await assert.rejects(failed.join(), /disk failed/);
  await assert.rejects(failed.start({ kind: 'propose', id: randomUUID() }), /disk failed/);
});
