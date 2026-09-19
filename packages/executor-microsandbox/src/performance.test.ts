import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeExecutorPerformance } from './performance.ts';

const revision = { id: 'planner', version: 'one' };
const phases = { createMs: 60, uploadMs: 5, executeMs: 25, cleanupMs: 10 };
const run = (id: string, startedAt: number, elapsedMs: number, status = 'complete') => ({
  id, revision, phase: 'released', receipt: { startedAt, elapsedMs, status, provider: { id: 'executor', version: 'one' } },
});

test('window cohorts exclude both unrelated history and unplaceable unfinished work', () => {
  const report = analyzeExecutorPerformance([
    run('before', 99, 900), run('first', 100, 100), run('last', 199, 200), run('end', 200, 800),
    { id: 'unfinished', revision, phase: 'running' },
  ], { from: 100, to: 200 });
  assert.deepEqual(report.selection, { totalRecords: 5, selectedRecords: 2, outsideWindow: 2, unplacedRecords: 1 });
  assert.deepEqual(report.overall.elapsed, { samples: 2, medianMs: 100, p95Ms: 100, maxMs: 200 });
  assert.equal(analyzeExecutorPerformance([{ id: 'unfinished', revision, phase: 'running' }]).overall.withoutReceipt, 1);
});

test('separates cancelled work and marks historical phase coverage unknown', () => {
  const report = analyzeExecutorPerformance([
    { ...run('measured', 1, 100), timings: phases }, run('historical', 2, 200), run('cancelled', 3, 900, 'cancelled'),
  ]);
  assert.deepEqual(report.overall.phaseCoverage, { measured: 1, missing: 2 });
  assert.equal(report.overall.byStatus.complete!.elapsed.maxMs, 200);
  assert.equal(report.overall.byStatus.cancelled!.elapsed.maxMs, 900);
  assert.equal(report.overall.byStatus.complete!.timings.createMs!.medianMs, 60);
  assert.equal(report.overall.byStatus.cancelled!.timings.createMs!.medianMs, null);
  assert.equal(report.overall.byStatus.failed!.elapsed.samples, 0);
});

test('keeps revision workloads distinct and strips source, input, output and errors', () => {
  const row = run('a', 1, 100);
  const report = analyzeExecutorPerformance([
    { ...row, source: 'PRIVATE', input: 'PRIVATE', output: 'PRIVATE', receipt: { ...row.receipt, error: 'PRIVATE' } },
    { ...run('b', 2, 300), revision: { ...revision, version: 'two' } },
  ]);
  assert.equal(report.byRevision.length, 2);
  assert.equal(report.byRevision[0]!.elapsed.maxMs, 100);
  assert.equal(report.byRevision[1]!.elapsed.maxMs, 300);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.equal(report.overall.providers.length, 1);
});

test('rejects duplicated receipts, malformed measurements and invalid windows', () => {
  const row = run('a', 1, 100);
  assert.throws(() => analyzeExecutorPerformance([row, row]), /Duplicate/);
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => analyzeExecutorPerformance([run('a', 1, value)]));
    assert.throws(() => analyzeExecutorPerformance([{ ...row, timings: { ...phases, cleanupMs: value } }]));
  }
  assert.throws(() => analyzeExecutorPerformance([{ ...row, timings: { createMs: 1 } }]));
  assert.throws(() => analyzeExecutorPerformance([{ id: 'a', revision, phase: 'running', timings: phases }]), /require a receipt/);
  for (const window of [{ from: 1, to: 1 }, { from: 2, to: 1 }, { from: -1, to: 1 }, { from: NaN, to: 2 }])
    assert.throws(() => analyzeExecutorPerformance([], window), /Performance window/);
  assert.equal(analyzeExecutorPerformance([]).overall.elapsed.medianMs, null);
});
