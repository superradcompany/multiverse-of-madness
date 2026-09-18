import assert from 'node:assert/strict';
import { DoomEngine } from '../examples/doom/bridge/src/engine.ts';
import { Jev } from '../examples/doom/server/src/jev.ts';
import { observePickups } from '../examples/doom/server/src/doom-pickup-memory.ts';
import { decisionStatistics } from '../examples/doom/server/src/decision-context.ts';
import { initialStats } from '../examples/doom/server/src/run-stats.ts';
// One live model request against a separate local engine. No running session changes.
const engine = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
const state = engine.state(), stats = initialStats(state);
const decision = await new Jev().decide(state,
  'Survive and finish the level. Gather useful resources, avoid repeated wandering, and use doors or switches when needed.',
  [], AbortSignal.timeout(15000), [], 35, {
    planTicks: 210, visited: stats.visited, stats: decisionStatistics(state, stats), pickups: observePickups(state),
  });
assert.ok(decision.plans);
assert.ok(decision.plans.candidates.some(p => p.id === decision.plans!.selected));
console.log(JSON.stringify({ liveJev: true, model: decision.model, confidence: decision.confidence,
  latencyMs: Math.round(decision.latencyMs), selected: decision.plans.selected,
  candidates: decision.plans.candidates.map(p => p.label) }));
