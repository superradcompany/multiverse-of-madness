import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { doomSupervisorEvidence } from './doom-supervisor-proposal.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';
import type { JevDecisionTrace } from './jev.ts';

const trace: JevDecisionTrace = { tick: 35, episode: 1, map: 1, model: 'test', selected: 'advance', confidence: .3,
  priority: 'exploration', probabilities: decision.probabilities,
  request: { state: { objective: 'Find the exit', marker: 'server-only diagnostic' },
    questions: { action: { type: 'choice', instructions: 'Use measured progress', criteria: { advance: 'Walk to the opening', left: 'Face the passage' } } } } };

test('latest consumed Jev evidence survives forks and restart without entering browser frames or inventing child choices', async () => {
  const returned = { ...structuredClone(decision), jevTrace: structuredClone(trace) };
  const session = new Session({ decide: async () => returned }, { threshold: 1, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
  const root = new Runtime('trace-root');
  await session.initialize(root); session.setPlanningMode('actions'); session.setPersistence(async () => {});
  session.step(); await session.idle();
  const saved = session.checkpoint();
  assert.equal(saved.worlds.filter(world => world.view.role === 'experiment').length, 2);
  for (const world of saved.worlds) assert.deepEqual(world.lastJevDecision, trace);
  returned.jevTrace.request.state = 'mutated caller value';
  assert.deepEqual(session.checkpoint().worlds[0]!.lastJevDecision, trace);
  assert.equal(JSON.stringify(session.snapshot()).includes('server-only diagnostic'), false);
  const observed = doomSupervisorEvidence(saved) as any;
  assert.deepEqual(observed.jevDecision.request, trace.request);
  assert.match(observed.jevDecision.scope, /not proof it won/);
  const restored = new Session({ decide: async () => structuredClone(decision) });
  await restored.restore(saved, async id => new Runtime(id, saved.worlds.find(world => world.view.id === id)!.view.state));
  assert.deepEqual(restored.checkpoint().worlds.map(world => world.lastJevDecision), saved.worlds.map(world => world.lastJevDecision));
  await restored.close(); await session.close();
});

test('a later non-Jev decision clears old diagnostics; absent legacy evidence is not reconstructed', async () => {
  let calls = 0;
  const session = new Session({ decide: async () => ({ ...structuredClone(decision), confidence: 1,
    ...(calls++ === 0 ? { jevTrace: structuredClone(trace) } : {}) }) }, { threshold: 0, horizon: 7, branches: 2, paceMs: 0, frameTicks: 7 });
  await session.initialize(new Runtime('trace-main')); session.setPlanningMode('actions'); session.setPersistence(async () => {});
  assert.equal((doomSupervisorEvidence(session.checkpoint()) as any).jevDecision, undefined);
  let paused: Promise<void> | undefined;
  session.setRecorder(async () => { if (calls === 1) paused = session.pause(); });
  session.resume(); await session.idle(); await paused;
  assert.deepEqual(session.checkpoint().worlds[0]!.lastJevDecision, trace);
  session.setRecorder(async () => { if (calls === 2) paused = session.pause(); });
  session.resume(); await session.idle(); await paused;
  assert.equal(calls, 2);
  assert.equal(session.checkpoint().worlds[0]!.lastJevDecision, undefined);
  await session.close();
});
