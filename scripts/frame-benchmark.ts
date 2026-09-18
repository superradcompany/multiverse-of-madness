import './runtime-env.ts';
import './build-bridge.ts';
import { createWorld } from '../examples/doom/server/src/runtime.ts';
const world = await createWorld(`mom-fps-${Date.now()}`);
try {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await world.step({ ticks: 1, inputs: [] });
    const frame = await world.frame();
    samples.push({ ms: performance.now() - start, bytes: frame.length });
  }
  console.log(JSON.stringify({ samples, averageMs: samples.reduce((sum, s) => sum + s.ms, 0) / samples.length }, null, 2));
} finally { await world.destroy(); }
