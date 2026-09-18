import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferedRecorder } from './buffered-recorder.ts';
import type { WorldView } from '../../../packages/contracts/src/session.ts';

test('recording compression does not stall a tick, while full buffers apply backpressure', async () => {
  const saved: WorldView[] = [];
  let release!: () => void;
  const disk = new Promise<void>(resolve => { release = resolve; });
  const recorder = new BufferedRecorder(async world => { await disk; saved.push(world); }, 2);
  const world = { id: 'world', label: 'test', state: { tick: 1 } } as WorldView;
  await recorder.record(world, Buffer.from('first'));
  world.state.tick = 2;
  let done = false;
  const second = recorder.record(world, Buffer.from('second')).then(() => { done = true; });
  world.state.tick = 3;
  await Promise.resolve();
  assert.equal(done, false);
  release(); await second;
  assert.deepEqual(saved.map(world => world.state.tick), [1, 2]);
});
