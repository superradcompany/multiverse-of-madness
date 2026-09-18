import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLeafArtifacts, type DependencyArtifact } from '../src/artifact-cleanup.ts';

const artifact = (key: string, dependencies: string[] = []): DependencyArtifact<string> => ({ key, identities: [key, `content:${key}`], dependencies, value: key });
test('cleanup respects content aliases, external children and dependency cycles', async () => {
  const inventory = [artifact('a'), artifact('b', ['content:a']), artifact('c', ['b']), artifact('retained', ['content:c']),
    artifact('orphan'), artifact('cycle1', ['cycle2']), artifact('cycle2', ['cycle1'])];
  const calls: string[] = [];
  const removed = await collectLeafArtifacts(['a', 'b', 'c', 'orphan', 'missing', 'cycle1', 'cycle2'], inventory, async key => { calls.push(key); });
  assert.deepEqual(removed, ['orphan', 'missing']);
  assert.deepEqual(calls, ['orphan']);
});
test('cleanup joins a dispatched deletion, then returns only acknowledged progress on cancellation', async () => {
  const controller = new AbortController();
  const removed = await collectLeafArtifacts(['parent', 'child'], [artifact('parent'), artifact('child', ['parent'])], async key => {
    assert.equal(key, 'child');
    controller.abort();
  }, controller.signal);
  assert.deepEqual(removed, ['child']);
});
test('adapter child guard remains authoritative if inventory becomes stale', async () => {
  const calls: string[] = [];
  await assert.rejects(collectLeafArtifacts(['parent', 'child'], [artifact('parent'), artifact('child', ['parent'])], async key => {
    calls.push(key);
    if (key === 'parent') throw new Error('new child exists');
  }), /new child exists/);
  assert.deepEqual(calls, ['child', 'parent']);
});
