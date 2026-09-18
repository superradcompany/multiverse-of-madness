import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, type QualificationRequest, type SupervisorProvider } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import { DoomLearningModels } from './doom-learning-models.ts';
import { DoomSupervisor, decodeDoomSupervisor } from './doom-supervisor.ts';
import { decodeDoomProposal, type DoomProposalEvidence, type DoomProposalRecord } from './doom-supervisor-proposal.ts';
import { DoomLearningJobs, decodeDoomLearningJobs, type SavedDoomLearningJobs } from './doom-learning-jobs.ts';
import type { DoomPolicy } from './doom-policy.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const draft = { kind: 'guidance', reason: 'Fixture hypothesis, not a proven improvement', prompts: { plan: 'Use observed progress to avoid repeating an ineffective waypoint.' } };
const qualify = (request: QualificationRequest<DoomPolicy>) => ({ baseline: request.baseline.revision, candidate: request.candidate.revision,
  context: request.context, contract: request.contract, accepted: false, reason: 'Fixture acceptance rejected', evidence: {} });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doom-learning-jobs-'));
  const hooks: { generate?: (signal: AbortSignal) => Promise<void>; qualify?: (signal: AbortSignal) => Promise<void>;
    persist?: (saved: SavedDoomLearningJobs) => Promise<void>; recover?: () => Promise<void> } = {};
  const session = new Session({ decide: async () => structuredClone(decision) });
  await session.initialize(new Runtime('root')); session.setPersistence(async () => {});
  const executables = new ExecutableStore(join(root, 'executables'));
  const models = new DoomLearningModels({ adapter: { id: 'fixture', version: '1' }, builtinExecutor: { id: 'host', version: '1' },
    profile: 'game-aware', executables, executable: () => { throw new Error('Source execution is not part of this fixture'); } });
  let generations = 0, evaluations = 0, configurations = 0, recoveries = 0;
  const supervisorOptions = { models, initial: models.baseline(session.learningPolicy()),
    store: new JsonFileStore(join(root, 'supervisor.json'), decodeDoomSupervisor),
    rules: { contract: { id: 'fixture-acceptance', version: '1' }, capabilities: ['prompts' as const], maxLifetimeMs: 60000 },
    qualify: async (request: QualificationRequest<DoomPolicy>, signal: AbortSignal) => { evaluations++; await hooks.qualify?.(signal); return qualify(request); } };
  let supervisor = await DoomSupervisor.open(supervisorOptions); await supervisor.adopt(session);
  const disk = new JsonFileStore(join(root, 'jobs.json'), decodeDoomLearningJobs);
  const stores = new Map<string, JsonFileStore<DoomProposalRecord>>();
  const proposalStore = (id: string) => {
    let store = stores.get(id); if (!store) { store = new JsonFileStore(join(root, id + '.json'), decodeDoomProposal); stores.set(id, store); } return store;
  };
  const provider: SupervisorProvider<DoomPolicy, DoomProposalEvidence> = { version: { id: 'fixture', version: '1' },
    propose: async (request, _limits, signal) => {
      generations++; await hooks.generate?.(signal);
      return { draft, receipt: { id: request.id, provider: provider.version, startedAt: Date.now(), elapsedMs: 1, inputBytes: 1, outputBytes: 1,
        requestedModel: 'fixture', servingModels: ['fixture'], status: 'complete', usage: { costMicros: 1, inputTokens: 1, outputTokens: 1 } } };
    } };
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { supervisorCalls: 10, costMicros: 10000 } });
  const options = () => ({ supervisor, proposalStore, store: { load: () => disk.load(), save: async (saved: SavedDoomLearningJobs) => {
    await disk.save(saved); await hooks.persist?.(saved);
  }, flush: () => disk.flush() }, recover: async () => { recoveries++; await hooks.recover?.(); },
  proposalOptions: async (id: string, store: JsonFileStore<DoomProposalRecord>) => {
    configurations++; return { id, supervisor, models, executables, store, ledger, provider, capture: () => session.checkpoint(),
      limits: { timeoutMs: 1000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 1000 } };
  } });
  let jobs = await DoomLearningJobs.open(options());
  return { root, hooks, disk, proposalStore, ledger, get jobs() { return jobs; }, get supervisor() { return supervisor; },
    get counts() { return { generations, evaluations, configurations, recoveries }; },
    reopen: async () => {
      await jobs.close().catch(() => {}); await supervisor.close();
      supervisor = await DoomSupervisor.open(supervisorOptions); supervisor.attach(session);
      jobs = await DoomLearningJobs.open(options());
    },
    cleanup: async () => { await jobs.close().catch(() => {}); await supervisor.close(); await ledger.join(); await rm(root, { recursive: true, force: true }); },
  };
}

test('background admission is immediate, duplicate requests are idempotent, and evaluation rejection is distinct from job failure', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.hooks.generate = async () => { entered.resolve(); await release.promise; };
    const command = { kind: 'propose' as const, id: randomUUID(), proposalKind: 'guidance' as const };
    const admission = await f.jobs.start(command); await entered.promise;
    assert.ok(['queued', 'running'].includes(admission.status)); assert.equal(f.jobs.busy, true);
    assert.equal((await f.jobs.start(command)).command.id, command.id);
    await assert.rejects(f.jobs.start({ kind: 'propose', id: randomUUID() }), /still running/);
    await assert.rejects(f.jobs.start({ kind: 'evaluate', id: command.id, proposalId: command.id }), /different request/);
    release.resolve(); await f.jobs.join();
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'complete'); assert.equal(f.counts.generations, 1);
    assert.equal((await f.proposalStore(command.id).load())!.request.evidence.requestedKind, 'guidance');
    await assert.rejects(f.jobs.start({ ...command, proposalKind: 'planner' }), /different request/);
    await f.jobs.start({ kind: 'evaluate', id: randomUUID(), proposalId: command.id }); await f.jobs.join();
    assert.equal(f.jobs.snapshot().jobs[1]!.status, 'complete'); assert.equal(f.jobs.snapshot().jobs[1]!.outcome, 'rejected');
    assert.equal(f.counts.evaluations, 1); assert.equal(f.supervisor.snapshot().journal.active.epoch, 0);
    await f.reopen(); await f.jobs.start(command); assert.equal(f.counts.generations, 1);
    await assert.rejects(f.jobs.start({ kind: 'evaluate', id: randomUUID(), proposalId: command.id }), /unevaluated/);
  } finally { release.resolve(); await f.cleanup(); }
});

test('cancellation stays nonterminal until provider cleanup finishes and never submits a late result', async () => {
  const f = await fixture(), entered = deferred(), aborted = deferred(), cleaned = deferred();
  try {
    f.hooks.generate = async signal => { signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await aborted.promise; await cleaned.promise; };
    const command = { kind: 'propose' as const, id: randomUUID() };
    await f.jobs.start(command); await entered.promise;
    assert.equal((await f.jobs.cancel(command.id)).status, 'cancelling'); await aborted.promise;
    await assert.rejects(f.jobs.start({ kind: 'propose', id: randomUUID() }), /cleaning up/);
    assert.equal(f.jobs.busy, true); assert.equal(f.supervisor.snapshot().journal.proposals.length, 0);
    cleaned.resolve(); await f.jobs.join();
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'cancelled'); assert.equal(f.jobs.busy, false);
    assert.equal(f.supervisor.snapshot().journal.proposals.length, 0); assert.equal(f.ledger.used('supervisorCalls'), 1);
    await f.jobs.start(command); assert.equal(f.counts.generations, 1);
  } finally { aborted.resolve(); cleaned.resolve(); await f.cleanup(); }
});

test('shutdown cancels and joins independent evaluation without closing the supervisor prematurely', async () => {
  const f = await fixture(), entered = deferred(), aborted = deferred(), cleaned = deferred();
  try {
    const id = randomUUID(); await f.jobs.start({ kind: 'propose', id }); await f.jobs.join();
    f.hooks.qualify = async signal => { signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await aborted.promise; await cleaned.promise; };
    await f.jobs.start({ kind: 'evaluate', id: randomUUID(), proposalId: id }); await entered.promise;
    const closing = f.jobs.close(); assert.equal(f.jobs.close(), closing); let finished = false; void closing.then(() => { finished = true; });
    await aborted.promise; assert.equal(finished, false); assert.equal(f.jobs.busy, true);
    await assert.rejects(f.jobs.start({ kind: 'propose', id: randomUUID() }), /closed/);
    cleaned.resolve(); await closing;
    assert.equal(f.jobs.snapshot().jobs[1]!.status, 'cancelled'); assert.equal(f.supervisor.snapshot().journal.proposals[0]!.status, 'cancelled');
    assert.equal(f.supervisor.snapshot().journal.active.epoch, 0);
  } finally { aborted.resolve(); cleaned.resolve(); await f.cleanup(); }
});

test('a lost job acknowledgment is recovered from the published proposal without constructing or invoking the provider', async () => {
  const f = await fixture();
  try {
    f.hooks.persist = async saved => { if (saved.jobs.some(job => job.status === 'complete')) throw new Error('Lost completion acknowledgment'); };
    const command = { kind: 'propose' as const, id: randomUUID() };
    await f.jobs.start(command); await assert.rejects(f.jobs.join(), /Lost completion/);
    await assert.rejects(f.jobs.start({ kind: 'propose', id: randomUUID() }), /publication failed/);
    assert.equal(f.counts.generations, 1); assert.equal(f.supervisor.snapshot().journal.proposals.length, 1);
    f.hooks.persist = undefined;
    // Simulate the other valid side of an ambiguous atomic-write acknowledgment: disk still has running.
    const saved = (await f.disk.load())!; saved.jobs[0]!.status = 'running'; delete saved.jobs[0]!.outcome; await f.disk.save(saved);
    await f.reopen();
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'complete'); assert.equal(f.jobs.snapshot().jobs[0]!.outcome, 'submitted');
    assert.equal(f.counts.configurations, 1); assert.equal(f.counts.generations, 1);
  } finally { await f.cleanup(); }
});

test('restart interrupts a durable admission with no generation record and does not retry it', async () => {
  const f = await fixture();
  try {
    f.hooks.persist = async saved => { if (saved.jobs.length) throw new Error('Stopped after durable admission'); };
    const command = { kind: 'propose' as const, id: randomUUID() };
    await assert.rejects(f.jobs.start(command), /Stopped after/); await assert.rejects(f.jobs.join(), /Stopped after/);
    assert.equal(f.counts.generations, 0);
    f.hooks.persist = undefined; await f.reopen();
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'interrupted');
    await f.jobs.start(command); assert.equal(f.counts.configurations, 0); assert.equal(f.counts.generations, 0);
    await f.jobs.start({ kind: 'propose', id: randomUUID() }); await f.jobs.join(); assert.equal(f.counts.generations, 1);
  } finally { await f.cleanup(); }
});

test('cancel during durable admission prevents provider construction', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.hooks.persist = async saved => { if (saved.jobs[0]?.status === 'queued') { entered.resolve(); await release.promise; } };
    const id = randomUUID(), start = f.jobs.start({ kind: 'propose', id }); await entered.promise;
    const cancel = f.jobs.cancel(id); release.resolve(); await start; await cancel; await f.jobs.join();
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'cancelled'); assert.equal(f.counts.configurations, 0); assert.equal(f.counts.generations, 0);
  } finally { release.resolve(); await f.cleanup(); }
});

test('resource recovery must finish before jobs can reopen and a failure leaves paid work untouched', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); await f.jobs.start({ kind: 'propose', id }); await f.jobs.join();
    f.hooks.recover = async () => { throw new Error('Executor cleanup still pending'); };
    await assert.rejects(f.reopen(), /cleanup still pending/);
    assert.equal(f.counts.generations, 1);
    f.hooks.recover = undefined; await f.reopen(); assert.equal(f.counts.generations, 1);
    const snapshot = f.jobs.snapshot(); snapshot.jobs[0]!.status = 'failed';
    assert.equal(f.jobs.snapshot().jobs[0]!.status, 'complete', 'polling cannot mutate the durable owner');
  } finally { await f.cleanup(); }
});
