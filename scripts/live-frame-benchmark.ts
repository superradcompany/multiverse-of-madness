import './runtime-env.ts';
import './build-bridge.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { Session } from '../apps/server/src/session.ts';
import { Jev } from '../apps/server/src/jev.ts';
import { createWorld } from '../apps/server/src/runtime.ts';
import type { SessionView } from '../packages/contracts/src/session.ts';
const session = new Session(new Jev());
const samples = new Map<string, { first: number; last: number; version: number; frames: number }>();
session.on('change', (view: SessionView) => {
  for (const world of view.worlds) {
    if (world.role !== 'experiment' || !world.trial?.elapsed || world.frameVersion <= 1) continue;
    const now = performance.now();
    const sample = samples.get(world.id);
    if (!sample) samples.set(world.id, { first: now, last: now, version: world.frameVersion, frames: 1 });
    else if (sample.version !== world.frameVersion) { sample.frames++; sample.version = world.frameVersion; sample.last = now; }
  }
});
try {
  await session.initialize(await createWorld(`mom-live-fps-${Date.now()}`));
  session.step(); await session.idle();
  if (session.snapshot().error) throw new Error(session.snapshot().error);
  const results = [...samples].map(([id, sample]) => ({ id, frames: sample.frames, elapsedMs: sample.last - sample.first, fps: (sample.frames - 1) * 1000 / (sample.last - sample.first) }));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/frame-benchmark.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await session.close(); }
