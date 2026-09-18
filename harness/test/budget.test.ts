import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger, BudgetExhausted, BudgetOverrun, type BudgetSnapshot } from '../src/budget.ts';
const spec = { simulationUnit: 'turns', limits: { simulation: 10, modelCalls: 2, inputTokens: 100 } };
const request = (owner: string, simulation = 6) => ({ owner, operation: 'play', reserve: { simulation } });

test('parallel worlds reserve against one total budget and unused confirmed capacity is released', async () => {
  const ledger = new BudgetLedger(spec);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = ledger.run(request('discarded-future'), async () => { await waiting; return { value: 'state', usage: { simulation: 4 } }; });
  await assert.rejects(ledger.run(request('other-future'), async () => assert.fail('must not dispatch')), BudgetExhausted);
  release(); assert.equal(await first, 'state');
  await ledger.run(request('winner'), async () => ({ value: null, usage: { simulation: 6 } }));
  assert.equal(ledger.used('simulation'), 10);
  assert.equal(ledger.remaining('simulation'), 0);
  assert.equal(ledger.snapshot().entries.length, 2);
});

test('multi-resource admission is atomic and actual usage cannot silently exceed its reservation', async () => {
  const ledger = new BudgetLedger(spec);
  await assert.rejects(ledger.run({ owner: 'model', operation: 'decide', reserve: { modelCalls: 1, inputTokens: 101 } }, async () => assert.fail('must not dispatch')), BudgetExhausted);
  assert.equal(ledger.used('modelCalls'), 0);
  await assert.rejects(ledger.run(request('bad-runtime', 2), async () => ({ value: null, usage: { simulation: 3 } })), BudgetOverrun);
  assert.equal(ledger.used('simulation'), 3);
  assert.equal(ledger.snapshot().entries[0]!.status, 'overrun');
  await assert.rejects(ledger.run(request('next', 1), async () => assert.fail('must stop')), /cannot continue/);
});

test('lost acknowledgments and failed operations remain charged across restart', async () => {
  let saved!: BudgetSnapshot;
  const ledger = new BudgetLedger(spec, async snapshot => { saved = snapshot; });
  const failure = new Error('connection lost');
  await assert.rejects(ledger.run(request('future'), async () => { throw failure; }), error => error === failure);
  assert.equal(saved.entries[0]!.status, 'failed');
  assert.equal(new BudgetLedger(spec, undefined, saved).used('simulation'), 6);
  saved.entries[0]!.status = 'pending'; delete saved.entries[0]!.usage;
  const restarted = new BudgetLedger(spec, undefined, saved);
  assert.equal(restarted.used('simulation'), 6);
  assert.equal(restarted.snapshot().entries[0]!.status, 'interrupted');
  await assert.rejects(restarted.run(request('retry'), async () => assert.fail('cannot reuse unknown budget')), BudgetExhausted);
});

test('reservations are published before work and storage failures prevent dispatch', async () => {
  const events: string[] = [];
  const ledger = new BudgetLedger(spec, async snapshot => { events.push(snapshot.entries.at(-1)!.status); });
  await ledger.run(request('world'), async () => { events.push('work'); return { value: null, usage: { simulation: 2 } }; });
  assert.deepEqual(events, ['pending', 'work', 'complete']);
  const error = new Error('disk full');
  const broken = new BudgetLedger(spec, async () => { throw error; });
  await assert.rejects(broken.run(request('first'), async () => assert.fail('must not dispatch')), cause => cause === error);
  await assert.rejects(broken.run(request('second', 1), async () => assert.fail('must remain stopped')), cause => cause === error);
});

test('cancellation joins already dispatched work and retains measured usage', async () => {
  const control = new AbortController(), ledger = new BudgetLedger(spec);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  let returned = false;
  const running = ledger.run(request('world'), async () => { entered(); await release; return { value: 1, usage: { simulation: 4 } }; }, control.signal).then(() => { returned = true; });
  await started; control.abort(); await Promise.resolve(); assert.equal(returned, false);
  finish(); await running;
  assert.equal(ledger.used('simulation'), 4);
  await assert.rejects(ledger.run(request('next'), async () => assert.fail('aborted'), control.signal), error => error instanceof Error && error.name === 'AbortError');
});

test('restart rejects a changed budget, malformed charges and invalid resource units', () => {
  const saved = new BudgetLedger(spec).snapshot();
  assert.throws(() => new BudgetLedger({ ...spec, limits: { simulation: 11 } }, undefined, saved), /does not match/);
  assert.throws(() => new BudgetLedger({ ...spec, simulationUnit: 'seconds' }, undefined, saved), /does not match/);
  assert.throws(() => new BudgetLedger({ simulationUnit: '', limits: {} }), /explicit simulation unit/);
  assert.throws(() => new BudgetLedger({ ...spec, limits: { simulation: 0.5 } }), /safe integers/);
  const ledger = new BudgetLedger(spec);
  const copy = ledger.snapshot(); copy.spec.limits.simulation = 1000;
  assert.equal(ledger.remaining('simulation'), 10);
});


test('zero is an enforced limit and cannot become an omitted unlimited resource on restart', async () => {
  const zero = { simulationUnit: 'turns', limits: { simulation: 0, modelCalls: 0 } };
  const ledger = new BudgetLedger(zero);
  await assert.rejects(ledger.run(request('world', 1), async () => assert.fail('zero budget')), BudgetExhausted);
  assert.throws(() => new BudgetLedger({ simulationUnit: 'turns', limits: {} }, undefined, ledger.snapshot()), /does not match/);
});


test('uncapped token usage can be measured without pretending a pre-dispatch bound is known', async () => {
  const ledger = new BudgetLedger({ simulationUnit: 'turns', limits: { modelCalls: 1 } });
  await ledger.run({ owner: 'model', operation: 'decide', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => ({
    value: 'answer', usage: { modelCalls: 1, inputTokens: 150, outputTokens: 12 },
  }));
  assert.equal(ledger.used('inputTokens'), 150);
  assert.equal(new BudgetLedger(ledger.snapshot().spec, undefined, ledger.snapshot()).used('outputTokens'), 12);
  const capped = new BudgetLedger(spec);
  await assert.rejects(capped.run({ owner: 'model', operation: 'decide', reserve: { modelCalls: 1 }, observe: ['inputTokens'] }, async () => assert.fail('cannot claim capped unreserved work')), /uncapped/);
});

test('executable calls share a hard total cap while elapsed wall time remains explicitly observed', async () => {
  const ledger = new BudgetLedger({ simulationUnit: 'turns', limits: { simulation: 1, modelCalls: 0, executorCalls: 1 } });
  await ledger.run({ owner: 'candidate', operation: 'executor', reserve: { executorCalls: 1 }, observe: ['executorWallMs'] }, async () => ({ value: 1, usage: { executorCalls: 1, executorWallMs: 430 } }));
  assert.equal(ledger.used('executorWallMs'), 430);
  await assert.rejects(ledger.run({ owner: 'extra', operation: 'executor', reserve: { executorCalls: 1 } }, async () => assert.fail('cannot dispatch extra compute')), BudgetExhausted);
  const restored = new BudgetLedger(ledger.snapshot().spec, undefined, ledger.snapshot());
  assert.equal(restored.used('executorCalls'), 1); assert.equal(restored.used('executorWallMs'), 430);
});
