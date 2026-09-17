import './runtime-env.ts';
import './build-bridge.ts';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createWorld, reconnectWorld } from '../apps/server/src/runtime.ts';
if (process.argv[2] === 'create') {
  const source = await createWorld(`mom-detached-${Date.now()}`);
  const [child] = await source.branch([`${source.id}-child`]);
  assert.ok(child);
  await child.step({ ticks: 14, inputs: ['right', 'forward'] });
  await writeFile('.cache/detached-smoke.json', JSON.stringify(await Promise.all([source, child].map(async w => ({ id: w.id, identity: w.identity, state: await w.state() })))));
  console.log('Source and child saved; exiting host process without stopping VMs.');
  process.exit(0);
} else {
  const records = JSON.parse(await readFile('.cache/detached-smoke.json', 'utf8'));
  for (const saved of records) {
    const world = await reconnectWorld(saved.id, saved.identity);
    try {
      assert.deepEqual(await world.state(), saved.state);
      const next = await world.step({ ticks: 7, inputs: ['forward'] });
      assert.equal(next.tick, saved.state.tick + 7);
      console.log(`PASS: ${world.id} survived host exit and continued at tick ${next.tick}`);
    } finally { await world.destroy(); }
  }
}
