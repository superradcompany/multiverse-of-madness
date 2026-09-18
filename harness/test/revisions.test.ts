import test from 'node:test';
import assert from 'node:assert/strict';
import { RevisionController } from '../src/revision-controller.ts';
import { compareRevisions, type EvaluationContract } from '../src/evaluation.ts';
import { contentRevision } from '../src/node/revision.ts';
import type { LearningRevision, Qualification, QualificationRequest, RevisionJournal, RevisionPorts, RevisionRules } from '../src/revisions.ts';

type Policy = { breadth: number };
const ref = (id: string) => ({ id, version: '1' });
function build(breadth: number, patch: Partial<Omit<LearningRevision<Policy>, 'revision'>> = {}): LearningRevision<Policy> {
  const data = { policy: { breadth }, prompts: { decide: 'choose a move' }, skills: [{ id: 'explore', instructions: 'seek new routes' }],
    executor: ref('executor'), model: ref('model'), adapter: ref('adapter'), ...patch };
  return { ...data, revision: contentRevision('learning-system', data) };
}
const limits = (): RevisionRules => ({ contract: ref('fixed-evaluator'), capabilities: ['policy', 'prompts', 'skills', 'executor'], maxLifetimeMs: 1000 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let now = 100, context = ref('guide-v1'), writes = 0, boundaries = 0;
  let durable: RevisionJournal<Policy> | undefined;
  const verify = async (value: LearningRevision<Policy>) => {
    const { revision, ...data } = value;
    assert.deepEqual(revision, contentRevision(revision.id, data));
    assert.ok(value.policy.breadth > 0);
  };
  const ports: RevisionPorts<Policy> = {
    verify, context: () => context, now: () => now,
    qualify: async request => report(request), compatible: async () => {},
    boundary: async work => { boundaries++; return work(); },
    persist: async state => { durable = structuredClone(state); writes++; },
  };
  return { ports, get saved() { return structuredClone(durable!); }, get writes() { return writes; }, get boundaries() { return boundaries; },
    time(value: number) { now = value; }, guide() { context = ref('guide-v2'); },
    open: () => RevisionController.create(build(1), limits(), ports),
    restore: () => RevisionController.restore(durable!, limits(), ports) };
}
function report(request: QualificationRequest<Policy>, accepted = true): Qualification {
  return { baseline: request.baseline.revision, candidate: request.candidate.revision, contract: request.contract,
    context: request.context, accepted, evidence: { retainedFailures: 2, totalSimulation: 12 }, reason: accepted ? 'improved every held-out case' : 'regressed' };
}
const proposal = (id = 'p1', breadth = 2) => ({ id, candidate: build(breadth), reason: 'explore another alternative', expiresAt: 900 });

test('qualification, boundary activation, restart and rollback retain immutable evidence and epochs', async () => {
  const f = fixture(); const c = await f.open();
  const input = proposal(); await c.submit(input);
  input.candidate.policy.breadth = 99;
  assert.equal((await c.evaluate('p1')).status, 'qualified');
  assert.equal(c.current.policy.breadth, 1);
  assert.equal((await c.activate('p1')).status, 'activated');
  assert.equal(f.boundaries, 1); assert.equal(c.current.policy.breadth, 2);
  const changed = c.current; changed.policy.breadth = 100;
  assert.equal(c.current.policy.breadth, 2);
  const restarted = await f.restore();
  assert.deepEqual(restarted.snapshot(), c.snapshot());
  await restarted.rollback(build(1).revision, 'observed a later regression');
  assert.equal(restarted.current.policy.breadth, 1); assert.equal(restarted.active.epoch, 2);
  assert.equal(restarted.snapshot().history.length, 2);
  assert.equal(restarted.snapshot().proposals[0]!.status, 'activated');
  assert.deepEqual(restarted.snapshot().proposals[0]!.qualification!.evidence, { retainedFailures: 2, totalSimulation: 12 });
  assert.deepEqual((await f.restore()).snapshot(), restarted.snapshot());
});

test('fixed independent evaluation rejects a regression and qualifies a measured improvement with total budgets', async () => {
  const f = fixture();
  const contract: EvaluationContract<{ initial: number }> = {
    id: 'held-out-turns', evaluator: ref('points'), scenarios: [{ id: 'a', seed: '17', input: { initial: 2 } }, { id: 'b', seed: '23', input: { initial: 5 } }],
    budget: { simulationUnit: 'turns', limits: { simulation: 6, modelCalls: 1 } }, maxRunMs: 1000,
    acceptance: { metric: 'points', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
  };
  const rules = { ...limits(), contract: contentRevision('contract', contract) };
  f.ports.qualify = async (request, signal) => {
    assert.deepEqual(request.contract, rules.contract);
    const result = await compareRevisions(contract, request.baseline.revision, request.candidate.revision, {
      run: async (revision, scenario, budget) => {
        const item = revision.version === request.baseline.revision.version ? request.baseline : request.candidate;
        await budget.run({ owner: 'discarded', operation: 'trial', reserve: { simulation: 3 } }, async () => ({ value: null, usage: { simulation: 3 } }));
        await budget.run({ owner: 'selected', operation: 'trial', reserve: { simulation: 3, modelCalls: 1 } }, async () => ({ value: null, usage: { simulation: 3, modelCalls: 1 } }));
        return { ending: 'budget', evidence: { points: scenario.input.initial + (item.policy.breadth === 3 ? -10 : item.policy.breadth) } };
      }, measure: data => data,
    }, signal);
    return { ...report(request, result.accepted), reason: result.reason, evidence: result };
  };
  const c = await RevisionController.create(build(1), rules, f.ports);
  await c.submit(proposal('bad', 3)); assert.equal((await c.evaluate('bad')).status, 'rejected');
  await assert.rejects(c.activate('bad'), /qualified/);
  await c.submit(proposal('good', 2)); assert.equal((await c.evaluate('good')).status, 'qualified');
  await c.activate('good');
  assert.equal(c.current.policy.breadth, 2); assert.equal(c.snapshot().proposals.length, 2);
});

test('evidence-driven rollback checks the exact epoch and goal inside the publication boundary', async () => {
  const f = fixture(), c = await f.open(); await c.submit(proposal()); await c.evaluate('p1'); await c.activate('p1');
  const expected = { activation: c.active, context: f.ports.context() };
  const blocked = deferred(), entered = deferred();
  f.ports.boundary = async work => { entered.resolve(); await blocked.promise; return work(); };
  const pending = c.rollback(build(1).revision, 'Regression evidence', expected);
  await entered.promise; f.guide(); blocked.resolve();
  await assert.rejects(pending, /stale/); assert.equal(c.active.epoch, 1);
  f.ports.boundary = async work => work();
  await c.rollback(build(1).revision, 'Current evidence', { activation: c.active, context: f.ports.context() });
  await c.submit(proposal('again')); await c.evaluate('again'); await c.activate('again');
  await assert.rejects(c.rollback(build(1).revision, 'Old epoch', { activation: expected.activation, context: f.ports.context() }), /stale/);
  assert.equal(c.active.epoch, 3);
});

test('candidate content, capabilities and lifetime are checked before publication', async () => {
  const f = fixture(); const c = await f.open();
  const forged = proposal(); forged.candidate.policy.breadth = 55;
  await assert.rejects(c.submit(forged));
  await assert.rejects(c.submit({ ...proposal(), candidate: build(2, { model: ref('other') }) }), /unsupported capabilities/);
  await assert.rejects(c.submit({ ...proposal(), candidate: build(1) }), /new revision/);
  await assert.rejects(c.submit({ ...proposal(), expiresAt: 1200 }), /lifetime/);
  await assert.rejects(c.submit({ ...proposal(), expiresAt: 100 }), /lifetime/);
  assert.equal(c.snapshot().proposals.length, 0); assert.equal(f.writes, 1);
  await c.submit(proposal()); await assert.rejects(c.submit(proposal()), /identity/);
});

test('no activation until fenced boundary and durable publication both finish', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal()); await c.evaluate('p1');
  const boundary = deferred(), started = deferred(), written = deferred();
  f.ports.boundary = async work => { started.resolve(); await boundary.promise; return work(); };
  const persist = f.ports.persist;
  f.ports.persist = async state => { await written.promise; await persist(state); };
  const activating = c.activate('p1'); await started.promise;
  assert.equal(c.active.epoch, 0);
  boundary.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.active.epoch, 0);
  written.resolve(); await activating; assert.equal(c.active.epoch, 1);
});

test('publication failure after a disk write requires reopening authoritative storage', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal()); await c.evaluate('p1');
  const persist = f.ports.persist;
  f.ports.persist = async next => { await persist(next); throw new Error('lost durable acknowledgment'); };
  await assert.rejects(c.activate('p1'), /lost durable/);
  assert.throws(() => c.current, /reopen/);
  await assert.rejects(c.submit(proposal('another', 3)), /reopen/);
  f.ports.persist = persist;
  const recovered = await f.restore();
  assert.equal(recovered.active.epoch, 1); assert.equal(recovered.current.policy.breadth, 2);
});

test('guide changes and expiration invalidate qualification without discarding its evidence', async () => {
  for (const change of ['guide', 'expiry'] as const) {
    const f = fixture(); const c = await f.open(); await c.submit(proposal());
    const started = deferred(), finish = deferred();
    f.ports.qualify = async request => { started.resolve(); await finish.promise; return report(request); };
    const evaluation = c.evaluate('p1'); await started.promise;
    if (change === 'guide') f.guide(); else f.time(900);
    finish.resolve();
    const result = await evaluation;
    assert.equal(result.status, change === 'guide' ? 'stale' : 'expired'); assert.ok(result.qualification);
    await assert.rejects(c.activate('p1'), /qualified/); assert.equal(c.active.epoch, 0);
  }
});

test('activation rechecks context and expiry after compatibility work', async () => {
  for (const change of ['guide', 'expiry'] as const) {
    const f = fixture(); const c = await f.open(); await c.submit(proposal()); await c.evaluate('p1');
    f.ports.compatible = async () => { if (change === 'guide') f.guide(); else f.time(900); };
    assert.equal((await c.activate('p1')).status, change === 'guide' ? 'stale' : 'expired');
    assert.equal(c.active.epoch, 0);
  }
});

test('a slow evaluation cannot activate after baseline changes and rolls back to the same revision', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal('slow', 3)); await c.submit(proposal('fast', 2));
  const started = deferred(), finish = deferred();
  f.ports.qualify = async request => {
    if (request.proposalId === 'slow') { started.resolve(); await finish.promise; }
    return report(request);
  };
  const slow = c.evaluate('slow'); await started.promise;
  await c.evaluate('fast'); await c.activate('fast'); await c.rollback(build(1).revision, 'restore');
  finish.resolve(); assert.equal((await slow).status, 'stale');
  assert.equal(c.active.epoch, 2); assert.equal(c.current.policy.breadth, 1);
});

test('restart retains interrupted work and refuses silent replay of its model and simulation costs', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal());
  const started = deferred(), finish = deferred();
  f.ports.qualify = async request => { started.resolve(); await finish.promise; return report(request); };
  const running = c.evaluate('p1'); await started.promise;
  const saved = f.saved;
  // A real restart has one writer; use a separate persistence port for the reconstructed instance.
  const recovered = await RevisionController.restore(saved, limits(), { ...f.ports, persist: async () => {} });
  assert.equal(recovered.snapshot().proposals[0]!.status, 'interrupted');
  await assert.rejects(recovered.evaluate('p1'), /already been evaluated/);
  finish.resolve(); await running;
});

test('cancellation waits for evaluator cleanup and never promotes a caught cancellation', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal());
  const started = deferred(), cleanup = deferred(); let joined = false;
  f.ports.qualify = async (request, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup.promise; joined = true; return report(request);
  };
  const running = c.evaluate('p1'); await started.promise;
  assert.throws(() => c.evaluate('p1'), /already running/);
  c.cancel('p1'); assert.equal(c.pending, 1); assert.equal(joined, false);
  cleanup.resolve(); assert.equal((await running).status, 'cancelled'); await c.join();
  assert.equal(joined, true); assert.equal(c.pending, 0);
  await assert.rejects(c.activate('p1'), /qualified/);
});

test('mismatched qualification identity and provider failure stay failed, not qualified', async () => {
  for (const failure of ['identity', 'provider'] as const) {
    const f = fixture(); const c = await f.open(); await c.submit(proposal());
    f.ports.qualify = async request => {
      if (failure === 'provider') throw new Error('provider unavailable');
      return { ...report(request), contract: ref('candidate-controlled-metric') };
    };
    const result = await c.evaluate('p1'); assert.equal(result.status, 'failed');
    assert.match(result.error!, failure === 'provider' ? /provider unavailable/ : /identity mismatch/);
    assert.equal(c.active.epoch, 0);
  }
});

test('rollback cannot activate an unevaluated artifact or incompatible executor', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal());
  await assert.rejects(c.rollback(build(2).revision, 'bypass'), /never active/);
  await c.evaluate('p1'); await c.activate('p1');
  f.ports.compatible = async () => { throw new Error('world format incompatible'); };
  await assert.rejects(c.rollback(build(1).revision, 'restore'), /incompatible/);
  assert.equal(c.active.epoch, 1);
});

test('restore rejects tampered history, missing artifacts, changed evaluator and forged qualification', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal()); await c.evaluate('p1'); await c.activate('p1');
  for (const change of [
    (s: RevisionJournal<Policy>) => { s.history = []; },
    (s: RevisionJournal<Policy>) => { s.artifacts.pop(); },
    (s: RevisionJournal<Policy>) => { s.proposals[0]!.qualification!.accepted = false; },
    (s: RevisionJournal<Policy>) => { s.proposals[0]!.capabilities.push('model'); },
    (s: RevisionJournal<Policy>) => { s.artifacts[1]!.policy.breadth = 99; },
  ]) {
    const saved = f.saved; change(saved);
    await assert.rejects(RevisionController.restore(saved, limits(), f.ports));
  }
  await assert.rejects(RevisionController.restore(f.saved, { ...limits(), contract: ref('different') }, f.ports), /rules changed/);
});

test('joining a failed evaluation still waits for every other dispatched evaluator', async () => {
  const f = fixture(); const c = await f.open(); await c.submit(proposal('first', 2)); await c.submit(proposal('second', 3));
  const firstStarted = deferred(), secondStarted = deferred(), firstFinish = deferred(), secondFinish = deferred();
  f.ports.qualify = async request => {
    if (request.proposalId === 'first') { firstStarted.resolve(); await firstFinish.promise; }
    else { secondStarted.resolve(); await secondFinish.promise; }
    return report(request);
  };
  const first = c.evaluate('first'); const firstFailed = assert.rejects(first, /disk offline/);
  const second = c.evaluate('second'); const secondFailed = assert.rejects(second, /reopen/);
  await firstStarted.promise; await secondStarted.promise;
  f.ports.persist = async () => { throw new Error('disk offline'); };
  let joined = false;
  const joinedResult = assert.rejects(c.join(), /disk offline/).then(() => { joined = true; });
  firstFinish.resolve(); await firstFailed;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(joined, false);
  secondFinish.resolve(); await secondFailed; await joinedResult;
  assert.equal(joined, true); assert.equal(c.pending, 0);
});

test('an already cancelled request and stale proposal dispatch no evaluator work', async () => {
  const f = fixture(); const c = await f.open();
  f.ports.qualify = async () => assert.fail('must not spend evaluation resources');
  await c.submit(proposal('cancelled')); const signal = new AbortController(); signal.abort();
  assert.equal((await c.evaluate('cancelled', signal.signal)).status, 'cancelled');
  await c.submit(proposal('stale', 3)); f.guide();
  assert.equal((await c.evaluate('stale')).status, 'stale');
});


test('generated proposals cannot bind themselves to a newer activation or changed user guide', async () => {
  const f = fixture(), controller = await f.open();
  const expected = { activation: controller.active, context: f.ports.context() };
  await controller.submit({ ...proposal(), expected }); await controller.evaluate('p1'); await controller.activate('p1');
  await assert.rejects(controller.submit({ ...proposal('old-generation', 3), expected }), /generation.*stale/);
  await controller.rollback(build(1).revision, 'Return to original policy');
  await assert.rejects(controller.submit({ ...proposal('aba-generation', 3), expected }), /generation.*stale/);
  const next = { activation: controller.active, context: f.ports.context() }; f.guide();
  await assert.rejects(controller.submit({ ...proposal('old-guide', 3), expected: next }), /generation.*stale/);
  assert.equal(controller.snapshot().proposals.length, 1);
});
