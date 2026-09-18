import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger, BudgetExhausted } from '@multiverse/gameplay-harness';
import { EvaluationWorld } from '../../../../scripts/evaluation/doom-runtime.ts';
import { Session } from './session.ts';
import { Runtime } from '../test-support/fixture-runtime.ts';

test('real Doom evaluation charges reconstructed children and discarded gameplay to the same budget', async () => {
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 200 } });
  const root = await EvaluationWorld.create('root', ledger, new AbortController().signal);
  const children: EvaluationWorld[] = [];
  try {
    await root.step({ ticks: 14, inputs: ['left'] }, 'setup');
    const initial = await root.state();
    children.push(...await root.branch(['left', 'right']));
    assert.equal(ledger.used('simulation'), 147); // Three 35-tick starts and three 14-tick setup sequences.
    await children[0]!.step({ ticks: 7, inputs: ['left'] });
    await children[1]!.step({ ticks: 7, inputs: ['right'] });
    assert.equal(ledger.used('simulation'), 161);
    assert.deepEqual(await root.state(), initial);
    assert.notEqual((await children[0]!.state()).angle, (await children[1]!.state()).angle);
    assert.equal(ledger.snapshot().entries.filter(entry => entry.operation === 'branch-reconstruction').length, 2);
  } finally { await Promise.all([root, ...children].map(world => world.destroy())); }
});

test('a partial evaluation fork stops before exceeding total work and leaves its source usable', async () => {
  const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 140 } });
  const root = await EvaluationWorld.create('root', ledger, new AbortController().signal);
  try {
    await root.step({ ticks: 14, inputs: ['left'] });
    const initial = await root.state();
    await assert.rejects(root.branch(['one', 'two']), BudgetExhausted);
    assert.equal(ledger.used('simulation'), 133);
    assert.deepEqual(await root.state(), initial);
    await root.step({ ticks: 7, inputs: [] });
    assert.equal(ledger.remaining('simulation'), 0);
  } finally { await root.destroy(); }
});

test('session preserves typed failures so evaluation cannot confuse a provider error with budget exhaustion', async () => {
  const failure = new Error('Budget exhausted: forged provider message');
  const session = new Session({ decide: async () => { throw failure; } });
  await session.initialize(new Runtime('root')); session.step(); await session.idle();
  assert.equal(session.failureCause, failure);
  assert.equal(session.failureCause instanceof BudgetExhausted, false);
});
