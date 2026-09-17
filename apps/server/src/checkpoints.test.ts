import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCheckpointSnapshots } from './checkpoints.ts';
const point = (id: string, parentDigest: string | null = null) => ({ id, digest: `sha256:${id}`, group: id, name: 'recovery', parentDigest, reference: `/snapshots/${id}` });
test('checkpoint cleanup follows cross-group ancestry, regardless of queue order', async () => {
  const inventory = [point('parent'), point('child', 'parent'), point('grandchild', 'child')];
  const calls: string[] = [];
  const result = await collectCheckpointSnapshots(['parent:recovery', 'child:recovery', 'grandchild:recovery'], inventory, async ref => { calls.push(ref); });
  assert.deepEqual(calls, ['/snapshots/grandchild', '/snapshots/child', '/snapshots/parent']);
  assert.deepEqual(result, ['grandchild:recovery', 'child:recovery', 'parent:recovery']);
});
test('retained or external children defer ancestor deletion without blocking unrelated cleanup', async () => {
  const calls: string[] = [];
  const inventory = [point('parent'), point('retained', 'parent'), point('obsolete')];
  const result = await collectCheckpointSnapshots(['parent:recovery', 'obsolete:recovery'], inventory, async ref => { calls.push(ref); });
  assert.deepEqual(result, ['obsolete:recovery']); assert.deepEqual(calls, ['/snapshots/obsolete']);
});
test('partial cleanup retries safely and accepts already deleted snapshots', async () => {
  const inventory = [point('parent'), point('child', 'parent')];
  await assert.rejects(collectCheckpointSnapshots(['parent:recovery', 'child:recovery'], inventory, async ref => {
    if (ref.endsWith('/parent')) throw new Error('storage failure');
    inventory.splice(1, 1);
  }), /storage failure/);
  const calls: string[] = [];
  const removed = await collectCheckpointSnapshots(['parent:recovery', 'child:recovery'], inventory, async ref => { calls.push(ref); });
  assert.deepEqual(calls, ['/snapshots/parent']); assert.equal(removed.length, 2);
});
test('digest parent references and a retained duplicate identity keep the parent protected', async () => {
  const inventory = [point('parent'), point('child', 'sha256:parent')];
  assert.deepEqual(await collectCheckpointSnapshots(['parent:recovery'], inventory, async () => { assert.fail('must retain parent'); }), []);
  const duplicate = { ...point('child', 'parent'), group: 'copy', reference: '/snapshots/copy' };
  const calls: string[] = [];
  assert.deepEqual(await collectCheckpointSnapshots(['child:recovery', 'parent:recovery'], [point('parent'), point('child', 'parent'), duplicate], async ref => { calls.push(ref); }), ['child:recovery']);
  assert.deepEqual(calls, ['/snapshots/child']);
});
