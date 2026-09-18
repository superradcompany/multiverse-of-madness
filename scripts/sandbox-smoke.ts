import './runtime-env.ts';
import './build-bridge.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorld, type WorldRuntime } from '../examples/doom/server/src/runtime.ts';
const worlds: WorldRuntime[] = [];
await mkdir('artifacts', { recursive: true });
try {
  const source = await createWorld(`mom-smoke-${Date.now()}`); worlds.push(source);
  const baseline = await source.state();
  console.log('branching at tick', baseline.tick);
  const children = await source.branch([`${source.id}-left`, `${source.id}-right`]); worlds.push(...children);
  const [left, right] = children;
  assert.ok(left && right);
  assert.deepEqual(await left.state(), baseline); assert.deepEqual(await right.state(), baseline);
  const l = await left.step({ ticks: 35, inputs: ['left', 'forward'] });
  const r = await right.step({ ticks: 35, inputs: ['right', 'forward'] });
  assert.notDeepEqual(l, r);
  assert.deepEqual(await source.state(), baseline);
  const lf = await left.frame(), rf = await right.frame(); assert.ok(!lf.equals(rf));
  await writeFile('artifacts/left.png', lf); await writeFile('artifacts/right.png', rf);
  const continued = await left.step({ ticks: 35, inputs: ['forward'] }); assert.equal(continued.tick, baseline.tick + 70);
  await writeFile('artifacts/sandbox-smoke.json', JSON.stringify({ baseline, left: l, right: r, continued }, null, 2));
  console.log('PASS: real VM children matched baseline, diverged, and winner continued');
} finally { for (const world of worlds.reverse()) await world.destroy(); }
