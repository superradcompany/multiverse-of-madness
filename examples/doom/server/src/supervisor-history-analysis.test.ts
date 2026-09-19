import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initial } from '../test-support/fixture-runtime.ts';

test('archive report counts unknown and pending usage honestly, deduplicates only examples, and omits payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-analysis-'));
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../../scripts/analyze-supervisor-history.ts', import.meta.url)), root]);
  try {
    await mkdir(join(root, 'provider'));
    const receipt = { id: 'a', status: 'complete', elapsedMs: 1000, inputBytes: 10000, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 70 } };
    const record = { phase: 'settled', receipt, request: { instructions: 'PRIVATE PROMPT', request: { evidence: {
      preparationExample: { state: initial, history: [initial, initial], defaultHistoryIndices: [0, 1] },
    } } } };
    await writeFile(join(root, 'provider', 'a.json'), JSON.stringify(record));
    await writeFile(join(root, 'provider', 'b.json'), JSON.stringify({ phase: 'settled', receipt: { id: 'b', status: 'cancelled', elapsedMs: 3000, inputBytes: 2000 }, tokenUsage: { inputTokens: 25, outputTokens: 5 } }));
    await writeFile(join(root, 'provider', 'c.json'), JSON.stringify({ phase: 'pending', receipt: { id: 'c', status: 'failed', elapsedMs: 0, inputBytes: 1000 } }));
    const { stdout } = await run(), report = JSON.parse(stdout);
    assert.equal(report.receipts, 3); assert.deepEqual(report.statuses, { complete: 1, cancelled: 1, pending: 1 });
    assert.deepEqual(report.reported, { inputTokens: 125, outputTokens: 15, knownTokenCalls: 2, unknownTokenCalls: 1, elapsedSamples: 2, inputSizeSamples: 3, medianElapsedMs: 2000, medianInputBytes: 2000 });
    assert.equal(report.historicalExampleReencoding.exactRepeats, 2);
    assert.ok(report.historicalExampleReencoding.savedBytes > 0);
    assert.match(report.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal((await run()).stdout, stdout);
    assert.ok(!stdout.includes('PRIVATE PROMPT')); assert.ok(!stdout.includes('defaultHistoryIndices'));
    const duplicate = join(root, 'lineages', 'copied', 'provider'); await mkdir(duplicate, { recursive: true });
    await writeFile(join(duplicate, 'a.json'), JSON.stringify(record));
    await assert.rejects(run(), /Duplicate provider receipt identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
