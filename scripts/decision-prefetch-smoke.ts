import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Session } from '../apps/server/src/session.ts';
import { Jev } from '../apps/server/src/jev.ts';
import { createWorld } from '../apps/server/src/runtime.ts';
import { navigateDoomInputs } from '../apps/server/src/doom-navigation.ts';
import { geometryFor } from '../apps/server/src/doom-geometry.ts';

const session = new Session(new Jev('game-aware'), { threshold: 0, horizon: 140, branches: 2, paceMs: 1000 / 35, frameTicks: 1 });
session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
session.setDecisionInterval(70);
const decisions: Array<{ tick: number; prefetched: boolean; waitMs: number; latencyMs: number }> = [];
const freshness: unknown[] = [];
session.on('decision-prefetch', value => freshness.push(value));
let previous: string | undefined;
session.on('change', view => {
  const current = view.decision;
  const key = current && `${current.sourceId}:${current.tick}`;
  if (current?.tick !== undefined && key !== previous) {
    previous = key;
    decisions.push({ tick: current.tick, prefetched: current.prefetched ?? false, waitMs: current.waitMs ?? 0, latencyMs: current.latencyMs ?? 0 });
  }
});
await session.initialize(await createWorld(`mom-prefetch-smoke-${randomUUID()}`));
let stop: ReturnType<typeof setTimeout> | undefined;
try {
  session.resume();
  await new Promise<void>((resolve, reject) => {
    stop = setTimeout(() => { void session.pause().then(resolve, reject); }, 20000);
  });
  assert.equal(session.snapshot().error, undefined);
  assert.ok(decisions.some(decision => decision.prefetched), 'No prefetched decision was usable in this run');
  console.log(JSON.stringify({ passed: true, decisions, freshness, selectedTicks: (session.snapshot().stats?.seconds ?? 0) * 35,
    reused: decisions.filter(decision => decision.prefetched).length }));
} finally { clearTimeout(stop); await session.close(); }
