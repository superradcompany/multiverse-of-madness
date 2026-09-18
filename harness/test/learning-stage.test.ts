import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger } from '../src/budget.ts';
import { executeLearningStage, type LearningStageRecord } from '../src/learning-stage.ts';
import type { ExecutableArtifact, ExecutableProvider } from '../src/executable.ts';

function fixture() {
  const artifact: ExecutableArtifact = { revision: { id: 'source', version: '1' }, source: { format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'throw new Error("never run on the host")' } } };
  const records: LearningStageRecord<{ observations: number[] }>[] = [];
  const hooks: { output: unknown; wrongIdentity?: boolean; cancel?: () => void } = { output: { index: 1 } };
  let calls = 0;
  const executor: ExecutableProvider = { version: { id: 'test', version: '1' }, execute: async (code, input, limits) => {
    calls++; (input as { observations: number[] }).observations[1] = 999;
    hooks.cancel?.();
    return { value: hooks.output, receipt: { revision: hooks.wrongIdentity ? { id: 'other', version: '1' } : code.revision, provider: executor.version,
      limits, runtime: { id: 'fixture', identity: 'fixture', image: 'fixture' }, status: 'complete', startedAt: 0, elapsedMs: 7, stdoutBytes: 10, stderrBytes: 0 } };
  } };
  const ledger = new BudgetLedger({ simulationUnit: 'turns', limits: { executorCalls: 1 } });
  const run = (signal = new AbortController().signal) => executeLearningStage({ observations: [4, 8] }, {
    stage: 'select-context', owner: 'revision-1', artifact, executor, ledger,
    limits: { timeoutMs: 1000, cpus: 1, memoryMiB: 128, maxInputBytes: 1000, maxOutputBytes: 1000 },
    record: async record => { records.push(record); },
    validate: (value, input) => {
      const index = (value as { index: number }).index;
      if (!Number.isInteger(index) || index < 0 || index >= input.observations.length) throw new Error('Invalid observation index');
      return input.observations[index];
    },
  }, signal);
  return { run, records, hooks, ledger, get calls() { return calls; } };
}
test('learning stages freeze input, validate outputs with the captured observations and retain metered provenance', async () => {
  const f = fixture(); assert.equal(await f.run(), 8);
  assert.deepEqual(f.records[0]!.input.observations, [4, 8]); assert.equal(f.records[0]!.stage, 'select-context');
  assert.equal(f.ledger.used('executorCalls'), 1); assert.equal(f.ledger.used('executorWallMs'), 7);
  await assert.rejects(f.run(), /Budget exhausted/); assert.equal(f.calls, 1);
});
test('invalid selections and mismatched receipts cannot cross the host boundary and still consume execution', async () => {
  for (const mode of ['output', 'identity']) {
    const f = fixture(); if (mode === 'output') f.hooks.output = { index: 100 }; else f.hooks.wrongIdentity = true;
    await assert.rejects(f.run(), /Invalid observation index|receipt does not match/);
    assert.equal(f.records.length, 1); assert.equal(f.ledger.used('executorCalls'), 1); assert.equal(f.ledger.used('executorWallMs'), 7);
  }
});
test('cancelled stages cannot produce a validated result', async () => {
  const f = fixture(), control = new AbortController(); f.hooks.cancel = () => control.abort();
  await assert.rejects(f.run(control.signal)); assert.equal(f.records.length, 1);
  const g = fixture(); await assert.rejects(g.run(control.signal)); assert.equal(g.calls, 0);
});
