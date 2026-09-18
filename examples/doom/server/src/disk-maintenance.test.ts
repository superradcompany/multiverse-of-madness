import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintainRootDisk, ROOT_LAYER_COMPACTION_THRESHOLD } from './disk-maintenance.ts';
import type { DiskCompactionOptions, DiskCompactionResult } from 'microsandbox';
const plan = (inputLayers: number): DiskCompactionResult => ({ dryRun: true, inputLayers, selectedLayers: inputLayers - 1, outputLayers: 2, materializedBytes: 0, totalUs: 0, pauseUs: 0, disks: [] });
test('root maintenance only inspects short chains and compacts before the runtime limit', async () => {
  for (const layers of [2, ROOT_LAYER_COMPACTION_THRESHOLD - 1, ROOT_LAYER_COMPACTION_THRESHOLD, 256]) {
    const calls: DiskCompactionOptions[] = [];
    await maintainRootDisk({ compact: async options => { calls.push(options); return plan(layers); } });
    assert.deepEqual(calls, layers < ROOT_LAYER_COMPACTION_THRESHOLD ? [{ rootDiskOnly: true, dryRun: true }] : [{ rootDiskOnly: true, dryRun: true }, { rootDiskOnly: true }]);
  }
});
test('failed maintenance stops capture rather than retrying uncertain runtime state', async () => {
  let calls = 0;
  await assert.rejects(maintainRootDisk({ compact: async options => { calls++; if (options.dryRun) return plan(256); throw new Error('disk adoption failed'); } }), /play stopped before capture: disk adoption failed/);
  assert.equal(calls, 2);
});
