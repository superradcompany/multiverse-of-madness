import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousLearning, type AutonomousLearningPorts, type AutonomousLearningState, type AutonomousJob } from '../src/autonomous-learning.ts';
import type { ProposalStatus } from '../src/revisions.ts';

function fixture() {
  let saved: AutonomousLearningState<number> | undefined, observed = 0, ids = 0, busy = false, boundary = false, failSave = false;
  const jobs = new Map<string, AutonomousJob>(), proposals = new Map<string, { status: ProposalStatus }>(), calls: string[] = [];
  const ports: AutonomousLearningPorts<number> = {
    store: { flush: async () => {}, load: async () => structuredClone(saved), save: async value => { if (failSave) throw new Error('disk failed'); saved = structuredClone(value); } },
    observe: previous => observed && observed !== previous ? { mark: observed, reason: 'new gameplay' } : undefined,
    id: () => String(++ids), busy: () => busy, job: id => jobs.get(id), proposal: id => proposals.get(id),
    propose: async id => { assert.ok(!jobs.has(id)); jobs.set(id, { status: 'running' }); calls.push('propose:' + id); },
    evaluate: async (id, proposalId) => { assert.ok(!jobs.has(id)); jobs.set(id, { status: 'running' }); proposals.set(proposalId, { status: 'evaluating' }); calls.push('evaluate:' + id); },
    activate: async id => { if (!boundary) return 'pending'; proposals.set(id, { status: 'activated' }); calls.push('activate:' + id); return 'activated'; },
    cancel: async cycle => { for (const id of [cycle.proposalId, cycle.evaluationId]) if (jobs.get(id)?.status === 'running') jobs.set(id, { status: 'cancelled' }); calls.push('cancel'); },
  };
  return { ports, calls, jobs, proposals, observe: (n: number) => { observed = n; }, busy: (v: boolean) => { busy = v; }, boundary: () => { boundary = true; }, failSave: () => { failSave = true; } };
}

test('new gameplay drives proposal, evaluation and boundary activation without user requests', async () => {
  const f = fixture(), loop = await AutonomousLearning.open(f.ports, true);
  await loop.tick(); assert.deepEqual(f.calls, []);
  f.observe(1); await Promise.all([loop.tick(), loop.tick(), loop.tick()]); assert.deepEqual(f.calls, ['propose:1']);
  f.proposals.set('1', { status: 'proposed' }); f.jobs.set('1', { status: 'complete' });
  await loop.tick(); assert.deepEqual(f.calls, ['propose:1', 'evaluate:2']);
  f.proposals.set('1', { status: 'qualified' }); f.jobs.set('2', { status: 'complete' });
  await loop.tick(); assert.equal(loop.snapshot().cycle?.proposalId, '1');
  f.boundary(); await loop.tick(); assert.equal(loop.snapshot().lastOutcome?.status, 'activated');
  await loop.tick(); assert.equal(f.calls.length, 3, 'same evidence cannot trigger another paid request');
  f.observe(2); await loop.tick(); assert.equal(f.calls.at(-1), 'propose:3');
});

test('restart reconciles in-flight jobs and resumes the chain without duplicate generation', async () => {
  const f = fixture(); let loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); await loop.tick(); await loop.close(); loop = await AutonomousLearning.open(f.ports);
  await loop.tick(); assert.deepEqual(f.calls, ['propose:1']);
  f.proposals.set('1', { status: 'proposed' }); f.jobs.set('1', { status: 'complete' }); await loop.tick();
  await loop.close(); loop = await AutonomousLearning.open(f.ports); await loop.tick(); assert.equal(f.calls.length, 2);
  f.proposals.set('1', { status: 'rejected' }); f.jobs.set('2', { status: 'complete' }); await loop.tick(); await loop.tick();
  assert.equal(loop.snapshot().lastOutcome?.status, 'rejected'); assert.equal(f.calls.length, 2);
});

test('paused automation cancels only its cycle and never dispatches while paused or a manual job owns execution', async () => {
  const f = fixture(), loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); f.busy(true); await loop.tick(); assert.equal(f.calls.length, 0);
  f.busy(false); await loop.tick(); await loop.setEnabled(false); f.observe(2); await loop.tick();
  assert.deepEqual(f.calls, ['propose:1', 'cancel']); assert.equal(loop.snapshot().enabled, false);
  await loop.setEnabled(true); await loop.tick(); assert.equal(loop.snapshot().lastOutcome?.status, 'cancelled');
  await loop.tick(); assert.equal(f.calls.at(-1), 'propose:3');
});

test('interrupted jobs require new gameplay; activation committed before lost acknowledgment is recovered', async () => {
  const f = fixture(); let loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); await loop.tick(); f.jobs.set('1', { status: 'interrupted' }); await loop.tick(); await loop.tick();
  assert.equal(f.calls.length, 1); f.observe(2); await loop.tick();
  f.proposals.set('3', { status: 'activated' }); await loop.close(); loop = await AutonomousLearning.open(f.ports); await loop.tick();
  assert.equal(loop.snapshot().lastOutcome?.status, 'activated'); assert.equal(f.calls.length, 2);
});

test('journal failure prevents dispatch; provider admission errors remain visible and pause the loop', async () => {
  const f = fixture(), loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); f.failSave(); await assert.rejects(loop.tick(), /disk failed/); await assert.rejects(loop.tick(), /disk failed/); assert.equal(f.calls.length, 0);
  const g = fixture(); g.ports.propose = async () => { throw new Error('provider unavailable'); };
  const other = await AutonomousLearning.open(g.ports, true); g.observe(1); await other.tick();
  assert.equal(other.snapshot().enabled, false); assert.equal(other.snapshot().error, 'provider unavailable');
});

test('activation consumes gameplay accumulated under the old revision and persists the new baseline across restart', async () => {
  const f = fixture(); let loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); await loop.tick();
  f.observe(20); // Gameplay kept running throughout proposal and testing.
  let observations = 0;
  f.ports.activationObservation = previous => { assert.equal(previous, 1); observations++; return 20; };
  f.proposals.set('1', { status: 'qualified' }); f.jobs.set('1', { status: 'complete' });
  await loop.tick(); assert.equal(observations, 0, 'queued activation has not changed live policy yet');
  f.boundary(); await loop.tick();
  assert.equal(observations, 1); assert.equal(loop.snapshot().lastObservation, 20);
  await loop.close(); loop = await AutonomousLearning.open(f.ports);
  await loop.tick(); assert.deepEqual(f.calls, ['propose:1', 'activate:1']);
  f.observe(21); await loop.tick(); assert.equal(f.calls.at(-1), 'propose:3');
});

test('recovered activation resets the baseline but rejected proposals keep their original evidence window', async () => {
  for (const status of ['activated', 'rejected'] as const) {
    const f = fixture(); let loop = await AutonomousLearning.open(f.ports, true);
    f.observe(1); await loop.tick(); f.proposals.set('1', { status });
    f.observe(20); let observations = 0;
    f.ports.activationObservation = () => { observations++; return 20; };
    await loop.close(); loop = await AutonomousLearning.open(f.ports); await loop.tick();
    assert.equal(observations, status === 'activated' ? 1 : 0);
    assert.equal(loop.snapshot().lastObservation, status === 'activated' ? 20 : 1);
    assert.equal(loop.snapshot().lastOutcome?.status, status);
  }
});

test('a failed save after refreshing the activation baseline fences further paid work', async () => {
  const f = fixture(), loop = await AutonomousLearning.open(f.ports, true);
  f.observe(1); await loop.tick();
  f.proposals.set('1', { status: 'activated' });
  f.ports.activationObservation = () => 20;
  f.observe(21); f.failSave();
  await assert.rejects(loop.tick(), /disk failed/);
  await assert.rejects(loop.tick(), /disk failed/);
  assert.deepEqual(f.calls, ['propose:1']);
});
