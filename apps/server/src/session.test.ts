import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.ts';
import { actions, type Decision, type DecisionMaker } from './jev.ts';
import type { WorldRuntime } from './runtime.ts';
import type { GameState, Step } from '../../../packages/contracts/src/game.ts';
const initial: GameState = { tick: 35, health: 100, armor: 0, ammo: [50, 0, 0, 0], kills: 0, items: 0, secrets: 0, x: 0, y: 0, z: 0, angle: 0, episode: 1, map: 1, phase: 'level', alive: true, velocity: { x: 0, y: 0, z: 0 }, enemies: [], projectiles: [], pickups: [], telemetry: { radius: 2048, lineOfSightKnown: false, engineObjectCount: 1 } };
const decision: Decision = { action: 'advance', confidence: 0.3, probabilities: Object.fromEntries(Object.keys(actions).map(k => [k, 1 / 8])) as Decision['probabilities'], priority: 'exploration', latencyMs: 10, model: 'test' };
class FakeWorld implements WorldRuntime {
  identity: string;
  destroyed = false;
  constructor(readonly id: string, private game = structuredClone(initial)) { this.identity = `uuid-${id}`; }
  async state() { return structuredClone(this.game); }
  async step(step: Step) { this.game.tick += step.ticks; this.game.x += step.inputs.includes('forward') ? step.ticks : 0; return this.state(); }
  async frame() { return Buffer.from(JSON.stringify(this.game)); }
  async branch(ids: string[]) { return ids.map(id => new FakeWorld(id, structuredClone(this.game))); }
  async destroy() { this.destroyed = true; }
}
const options = { threshold: 0.75, horizon: 14, branches: 2, paceMs: 0 };
test('equal horizon experiments preserve source and promotion leaves exactly one main', async () => {
  const main = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(main); s.step(); await s.idle();
  const view = s.snapshot();
  assert.equal(view.stage, 'choosing');
  assert.equal((await main.state()).tick, 35);
  assert.deepEqual(view.worlds.filter(w => w.role === 'experiment').map(w => w.state.tick), [49, 49]);
  s.step(); await s.idle();
  assert.equal(s.snapshot().worlds.filter(w => w.role === 'main').length, 1);
  assert.ok(main.destroyed);
});
test('takeover fences a delayed Jev response before allowing manual input', async () => {
  let finish!: (value: Decision) => void;
  const decider: DecisionMaker = { decide: () => new Promise(resolve => { finish = resolve; }) };
  const main = new FakeWorld('root');
  const s = new Session(decider, options); await s.initialize(main); s.resume();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const takeover = s.takeover('root'); finish(decision); await takeover;
  assert.equal((await main.state()).tick, 35);
  assert.equal(s.snapshot().worlds.length, 1);
  await s.input('root', ['forward']);
  assert.equal((await main.state()).tick, 42);
  s.release('root'); assert.equal(s.snapshot().running, false);
});
test('recovery reads engine state rather than replaying input from stale persisted metadata', async () => {
  const main = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options); await s.initialize(main);
  const saved = s.checkpoint();
  await main.step({ ticks: 7, inputs: ['forward'] });
  const recovered = new Session({ decide: async () => decision }, options);
  await recovered.restore(saved, async (id, identity) => { assert.equal(id, main.id); assert.equal(identity, main.identity); return main; });
  assert.equal(recovered.snapshot().worlds[0]!.state.tick, 42);
  assert.equal(recovered.snapshot().running, false);
});

test('Jev input bounds current entities and does not duplicate scene telemetry in history', async () => {
  const { decisionState } = await import('./jev.ts');
  const entity = { kind: 'projectile' as const, engineType: 33, health: 1, position: { x: 1, y: 2, z: 3 }, distance: 42.111111111, relativeBearing: 11.111111, heading: 22.22222, direction: { x: 0.123, y: 0.456 }, towardPlayerAlignment: 0.99999 };
  const busy = { ...initial, enemies: Array(16).fill(entity), projectiles: Array(24).fill(entity), pickups: Array(16).fill(entity) };
  const state = decisionState(busy, 'x'.repeat(1000), Array(10).fill(busy));
  assert.ok(JSON.stringify(state).length < 5000);
  assert.equal(state.projectiles.length, 8);
  assert.equal(state.omitted.projectiles, 16);
  assert.equal(state.recentPlayerStates.length, 4);
  assert.ok(!('projectiles' in state.recentPlayerStates[0]!));
});

test('manual play can pause and resume without giving control back to AI', async () => {
  const s = new Session({ decide: async () => { throw new Error('AI must not run'); } }, options);
  await s.initialize(new FakeWorld('root')); await s.takeover('root');
  await s.input('root', []); assert.equal(s.snapshot().worlds[0]!.state.tick, 42);
  await s.pause();
  await assert.rejects(s.input('root', ['forward']), /Take control/);
  s.resume(); await s.input('root', ['forward']);
  assert.equal(s.snapshot().worlds[0]!.state.tick, 49);
  assert.equal(s.snapshot().worlds[0]!.controller, 'human');
});

test('manual changes require explicit choice and may keep the existing main', async () => {
  const main = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(main); s.step(); await s.idle(); await s.takeover('root');
  await s.input('root', ['forward']); s.release('root');
  assert.throws(() => s.resume(), /Choose which world/);
  assert.equal(s.snapshot().running, false);
  await s.promote('root');
  assert.equal(s.snapshot().mainId, 'root');
  assert.equal(s.snapshot().worlds.filter(w => w.role === 'experiment').length, 0);
  assert.equal(main.destroyed, false);
});

test('restart recovers children created during an interrupted fork', async () => {
  const main = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options); await s.initialize(main);
  const saved = s.checkpoint();
  saved.pendingFork = { parentId: 'root', ids: ['child-a', 'child-b'], actions: ['left', 'right'] };
  const child = new FakeWorld('child-a');
  const recovered = new Session({ decide: async () => decision }, options);
  await recovered.restore(saved, async () => main, async id => id === 'child-a' ? child : undefined);
  assert.equal(recovered.snapshot().worlds.length, 2);
  assert.equal(recovered.snapshot().stage, 'exploring');
  recovered.step(); await recovered.idle();
  assert.equal(recovered.snapshot().worlds.find(w => w.id === 'child-a')!.state.tick, 49);
});

test('takeover waits for every dispatched branch operation even if another one fails', async () => {
  let finish!: () => void;
  let entered!: () => void;
  const slowStarted = new Promise<void>(resolve => { entered = resolve; });
  class BrokenBranch extends FakeWorld { override async step(): Promise<GameState> { throw new Error('transport failure'); } }
  class SlowBranch extends FakeWorld { override async step(step: Step) { entered(); await new Promise<void>(resolve => { finish = resolve; }); return super.step(step); } }
  class Source extends FakeWorld { override async branch(ids: string[]) { return [new BrokenBranch(ids[0]!), new SlowBranch(ids[1]!)]; } }
  const s = new Session({ decide: async () => decision }, options); await s.initialize(new Source('root'));
  s.step(); await slowStarted;
  let acquired = false;
  const takeover = s.takeover('root').then(() => { acquired = true; });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(acquired, false);
  finish(); await takeover; assert.equal(acquired, true);
});

test('automatic comparison holds results, can be paused, and retains outcome identities', async () => {
  const s = new Session({ decide: async () => decision }, { ...options, reviewMs: 80, continueMs: 80 });
  await s.initialize(new FakeWorld('root')); s.step(); await s.idle();
  assert.equal(s.snapshot().comparison?.selected, false);
  s.resume();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(s.snapshot().mainId, 'root');
  assert.ok(s.snapshot().reviewEndsAt);
  await s.pause(); assert.equal(s.snapshot().mainId, 'root');
  assert.equal(s.snapshot().reviewEndsAt, undefined);
  s.step(); await s.idle();
  assert.equal(s.snapshot().comparison?.selected, true);
  assert.equal(s.snapshot().comparison?.candidateIds.length, 2);
  assert.ok(s.snapshot().worlds.some(w => w.role === 'archived' && s.snapshot().comparison?.candidateIds.includes(w.id)));
});


test('confidence boundary chooses direct execution and publishes the actual preferences', async () => {
  const s = new Session({ decide: async () => ({ ...decision, confidence: 0.75 }) }, options);
  await s.initialize(new FakeWorld('root'));
  let paused = false;
  s.on('change', () => {
    if (!paused && s.snapshot().worlds[0]!.state.tick >= 70) { paused = true; void s.pause(); }
  });
  s.resume(); await s.idle();
  const view = s.snapshot();
  assert.equal(view.worlds.length, 1);
  assert.equal(view.decision?.mode, 'direct');
  assert.equal(view.decision?.tick, 35);
  assert.equal(view.decision?.preferences?.length, 8);
  assert.equal(view.decision?.preferences?.some(p => p.tested), false);
  assert.equal(view.routing?.direct, 1);
  assert.equal(view.routing?.uncertain, 0);
});

test('below threshold triggers experiments and preserves decision evidence across restore', async () => {
  const s = new Session({ decide: async () => ({ ...decision, confidence: 0.749 }) }, options);
  await s.initialize(new FakeWorld('root'));
  let paused = false;
  s.on('change', () => { if (!paused && s.snapshot().stage === 'choosing') { paused = true; void s.pause(); } });
  s.resume(); await s.idle();
  assert.equal(s.snapshot().decision?.mode, 'uncertain');
  assert.equal(s.snapshot().decision?.preferences?.filter(p => p.tested).length, 2);
  assert.equal(s.snapshot().routing?.uncertain, 1);
  const saved = s.checkpoint();
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async id => new FakeWorld(id, saved.worlds.find(w => w.view.id === id)!.view.state));
  assert.deepEqual(restored.snapshot().decision, s.snapshot().decision);
  assert.deepEqual(restored.snapshot().routing, s.snapshot().routing);
});

test('manual exploration is labelled separately even above the confidence threshold', async () => {
  const s = new Session({ decide: async () => ({ ...decision, confidence: 0.99 }) }, options);
  await s.initialize(new FakeWorld('root')); s.step(); await s.idle();
  assert.equal(s.snapshot().decision?.mode, 'manual');
  assert.equal(s.snapshot().routing?.manual, 1);
  assert.equal(s.snapshot().routing?.uncertain, 0);
});


test('future continuations ask Jev again after the opening action and preserve the whole path', async () => {
  let calls = 0;
  const s = new Session({ decide: async () => { calls++; return { ...decision, action: calls === 1 ? 'advance' : 'wait' }; } }, { ...options, horizon: 70 });
  const recorded = new Map<string, number[]>();
  s.setRecorder(async world => { const ticks = recorded.get(world.id) ?? []; ticks.push(world.state.tick); recorded.set(world.id, ticks); });
  await s.initialize(new FakeWorld('root')); s.step(); await s.idle();
  assert.equal(calls, 3); // one opening choice plus one fresh decision per child
  const children = s.snapshot().worlds.filter(w => w.role === 'experiment');
  assert.deepEqual(children.map(w => w.state.tick), [105, 105]);
  assert.deepEqual(children.map(w => w.state.x), [35, 35]); // stop advancing after tick 70
  assert.deepEqual(children.map(w => w.currentAction), ['wait briefly', 'wait briefly']);
  for (const world of children) assert.deepEqual(recorded.get(world.id), [35, 42, 49, 56, 63, 70, 77, 84, 91, 98, 105]);
  s.step(); await s.idle();
  const main = s.snapshot().worlds.find(w => w.role === 'main')!;
  assert.equal(main.state.tick, 105);
  assert.equal(main.state.x, 35);
});

test('garbage collection retries only journaled loser identities', async () => {
  class FailingCleanup extends FakeWorld { override async destroy() { throw new Error('temporary cleanup failure'); } }
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(new FailingCleanup('root')); s.step(); await s.idle();
  s.step(); await s.idle();
  assert.match(s.snapshot().error!, /cleanup failure/);
  const winner = s.snapshot().mainId;
  const deleted: string[] = [];
  await s.collectGarbage(async (id, identity) => { assert.equal(identity, `uuid-${id}`); deleted.push(id); });
  assert.deepEqual(deleted, ['root']);
  assert.equal(s.checkpoint().cleanup?.length, 0);
  assert.equal(s.snapshot().mainId, winner);
});

test('optional experience uses discarded-future outcomes, survives restart, and can be disabled or cleared', async () => {
  const supplied: number[] = [];
  const maker: DecisionMaker = { decide: async (_state, _objective, _history, _signal, experiences) => {
    supplied.push(experiences?.length ?? 0); return { ...decision, experienceUsed: experiences?.length ?? 0 };
  } };
  const s = new Session(maker, options); s.useExperience(true);
  await s.initialize(new FakeWorld('root')); s.step(); await s.idle();
  assert.equal(s.snapshot().experience?.stored, 2);
  s.step(); await s.idle();
  const saved = s.checkpoint();
  const restored = new Session(maker, options);
  await restored.restore(saved, async id => new FakeWorld(id, saved.worlds.find(w => w.view.id === id)!.view.state));
  assert.equal(restored.snapshot().experience?.enabled, true);
  restored.step(); await restored.idle();
  assert.deepEqual(supplied, [0, 2]);
  assert.equal(restored.snapshot().experience?.used, 2);
  restored.step(); await restored.idle();
  restored.useExperience(false); restored.step(); await restored.idle();
  assert.equal(supplied.at(-1), 0);
  assert.ok(restored.snapshot().experience!.stored > 0);
  restored.clearExperience(); assert.equal(restored.snapshot().experience?.stored, 0);
});

test('experience retrieval excludes mismatched contexts and stays bounded', async () => {
  const { ExperienceMemory } = await import('./experience.ts');
  const memory = new ExperienceMemory();
  for (let i = 0; i < 150; i++) memory.remember(`world-${i}`, i % 2 ? 'wait' : 'move', initial, { ...initial, tick: 70, health: 90 });
  assert.equal(memory.records.length, 128);
  assert.equal(memory.relevant(initial).length, 3);
  for (const state of [{ ...initial, map: 2 }, { ...initial, x: 1000 }, { ...initial, angle: 180 }, { ...initial, ammo: [0, 0, 0, 0] }]) assert.equal(memory.relevant(state).length, 0);
  const { decisionState } = await import('./jev.ts');
  const input = decisionState(initial, 'survive', [], memory.relevant(initial));
  assert.equal(input.relatedAttempts.length, 3);
  assert.ok(JSON.stringify(input).length <= 5000);
  assert.equal(input.relatedAttempts[0]!.observed.health, -10);
});

test('a slow future decision does not block a sibling and pause fences the pending decision', async () => {
  let calls = 0;
  let release!: (value: Decision) => void;
  let siblingFinished!: () => void;
  const progressed = new Promise<void>(resolve => { siblingFinished = resolve; });
  const s = new Session({ decide: async () => {
    calls++;
    if (calls === 2) return new Promise<Decision>(resolve => { release = resolve; });
    return decision;
  } }, { ...options, horizon: 70 });
  s.setRecorder(async world => { if (world.role === 'experiment' && world.state.tick === 105) siblingFinished(); });
  await s.initialize(new FakeWorld('root')); s.step();
  await progressed;
  const children = s.snapshot().worlds.filter(w => w.role === 'experiment');
  assert.deepEqual(children.map(w => w.state.tick).sort((a, b) => a - b), [70, 105]);
  assert.equal(children.find(w => w.state.tick === 70)!.thinking, true);
  let paused = false;
  const pause = s.pause().then(() => { paused = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(paused, false);
  release(decision); await pause;
  assert.deepEqual(s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => w.state.tick).sort((a, b) => a - b), [70, 105]);
  assert.ok(s.snapshot().worlds.every(w => !w.thinking));
});

test('restart commits a fresh root before clearing footage and destroying old worlds', async () => {
  const old = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(old); s.useExperience(true); s.step(); await s.idle();
  const saved: import('./session.ts').SessionCheckpoint[] = [];
  s.setPersistence(async value => { saved.push(value); });
  await s.restart(async () => new FakeWorld('fresh'), async id => {
    assert.equal(id, 'fresh'); assert.equal(old.destroyed, false);
    assert.equal(saved.at(-1)?.view.mainId, 'fresh');
    assert.equal(saved.at(-1)?.recordingResetTo, 'fresh');
    assert.ok(saved.at(-1)?.cleanup?.some(c => c.id === 'root'));
  });
  assert.equal(old.destroyed, true);
  assert.equal(s.snapshot().worlds.length, 1);
  assert.equal(s.snapshot().mainId, 'fresh');
  assert.equal(s.snapshot().worlds[0]!.generation, 0);
  assert.equal(s.snapshot().worlds[0]!.state.health, 100);
  assert.equal(s.snapshot().experience?.stored, 0);
  assert.equal(s.snapshot().running, false);
  assert.equal(s.checkpoint().recordingResetTo, undefined);
  assert.deepEqual(s.checkpoint().cleanup, []);
});

test('a failed replacement leaves the current game and recordings intact', async () => {
  const old = new FakeWorld('root'); const s = new Session({ decide: async () => decision }, options);
  await s.initialize(old);
  let cleared = false;
  await assert.rejects(s.restart(async () => { throw new Error('create failed'); }, async () => { cleared = true; }), /create failed/);
  assert.equal(cleared, false); assert.equal(old.destroyed, false); assert.equal(s.snapshot().mainId, 'root');
});

test('interrupted recording reset remains journaled and can finish after reconnect', async () => {
  const root = new FakeWorld('root'), fresh = new FakeWorld('fresh');
  const s = new Session({ decide: async () => decision }, options); await s.initialize(root);
  await assert.rejects(s.restart(async () => fresh, async () => { throw new Error('disk temporarily unavailable'); }), /disk temporarily/);
  const saved = s.checkpoint(); assert.equal(saved.recordingResetTo, 'fresh');
  assert.equal(saved.view.mainId, 'fresh'); assert.equal(root.destroyed, false);
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async () => fresh, undefined, async (id, identity) => { assert.equal(id, 'root'); assert.equal(identity, root.identity); await root.destroy(); });
  let cleared = '';
  await restored.finishRecordingReset(async id => { cleared = id; });
  assert.equal(cleared, 'fresh'); assert.equal(restored.checkpoint().recordingResetTo, undefined);
  assert.equal(restored.snapshot().worlds.length, 1); assert.equal(root.destroyed, true);
});

test('winner delay defaults to zero, persists, and can release an active review early', async () => {
  const s = new Session({ decide: async () => decision }, { ...options, continueMs: 0 });
  await s.initialize(new FakeWorld('root'));
  assert.equal(s.snapshot().winnerDelaySeconds, 0);
  s.setWinnerDelay(60); s.step(); await s.idle();
  s.resume(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(s.snapshot().reviewEndsAt); assert.equal(s.snapshot().mainId, 'root');
  const promoted = new Promise<void>(resolve => {
    const changed = () => {
      if (s.snapshot().mainId === 'root') return;
      s.off('change', changed);
      void s.pause().then(resolve);
    };
    s.on('change', changed);
  });
  s.setWinnerDelay(0); await promoted;
  assert.notEqual(s.snapshot().mainId, 'root');
  assert.equal(s.checkpoint().view.winnerDelaySeconds, 0);
  assert.throws(() => s.setWinnerDelay(-1), /between/);
  assert.throws(() => s.setWinnerDelay(Infinity), /between/);
});

test('configured feedback interval reaches Jev and preserves the fixed trial horizon', async () => {
  const observed: Array<{ tick: number; duration: number | undefined }> = [];
  const s = new Session({ decide: async (state, _objective, _history, _signal, _experience, actionTicks) => {
    observed.push({ tick: state.tick, duration: actionTicks });
    return { ...decision, action: state.tick === 35 ? 'advance' : 'wait' };
  } }, { ...options, horizon: 105 });
  await s.initialize(new FakeWorld('root')); s.setDecisionInterval(70);
  s.step(); await s.idle();
  assert.deepEqual(observed, [{ tick: 35, duration: 70 }, { tick: 105, duration: 35 }, { tick: 105, duration: 35 }]);
  assert.deepEqual(s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => [w.state.tick, w.state.x]), [[140, 70], [140, 70]]);
  const saved = s.checkpoint();
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async id => new FakeWorld(id, structuredClone(saved.worlds.find(w => w.view.id === id)!.view.state)));
  assert.equal(restored.snapshot().decisionIntervalTicks, 70);
  assert.throws(() => s.setDecisionInterval(0), /interval/);
  assert.throws(() => s.setDecisionInterval(7.5), /interval/);
});

test('director keeps the same panes after selection and while the next decision is pending', async () => {
  const { directorWorlds } = await import('../../web/src/director.tsx');
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(new FakeWorld('root')); s.step(); await s.idle();
  const ids = directorWorlds(s.snapshot()).map(w => w.id);
  assert.equal(ids.length, 2);
  s.step(); await s.idle();
  assert.deepEqual(directorWorlds(s.snapshot()).map(w => w.id), ids);
  assert.deepEqual(directorWorlds({ ...s.snapshot(), stage: 'deciding', comparison: undefined }).map(w => w.id), ids);
  assert.deepEqual(directorWorlds({ ...s.snapshot(), stage: 'forking', comparison: undefined }).map(w => w.id), ids);
});

test('trial duration applies to the next batch and persists without shortening existing experiments', async () => {
  const s = new Session({ decide: async () => decision }, { ...options, horizon: 70 });
  await s.initialize(new FakeWorld('root'));
  s.setTrialDuration(105);
  let changed = false;
  s.setRecorder(async world => {
    if (world.role === 'experiment' && world.state.tick > 35 && !changed) { changed = true; s.setTrialDuration(35); }
  });
  s.step(); await s.idle();
  const first = s.snapshot();
  assert.equal(first.trialDurationTicks, 35);
  assert.deepEqual(first.worlds.filter(w => w.role === 'experiment').map(w => [w.state.tick, w.trial?.total]), [[140, 105], [140, 105]]);
  s.step(); await s.idle(); // promote
  s.step(); await s.idle(); // next batch uses 35 ticks
  assert.deepEqual(s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => [w.state.tick, w.trial?.total]), [[175, 35], [175, 35]]);
  const saved = s.checkpoint();
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async id => new FakeWorld(id, structuredClone(saved.worlds.find(w => w.view.id === id)!.view.state)));
  assert.equal(restored.snapshot().trialDurationTicks, 35);
  assert.deepEqual(restored.snapshot().worlds.filter(w => w.role === 'experiment').map(w => w.trial?.total), [35, 35]);
  assert.throws(() => s.setTrialDuration(0), /duration/);
  assert.throws(() => s.setTrialDuration(2101), /duration/);
  assert.throws(() => s.setTrialDuration(35.5), /duration/);
});

test('an interrupted fork retains its captured horizon even if the next-batch setting differs', async () => {
  const s = new Session({ decide: async () => decision }, options); await s.initialize(new FakeWorld('root'));
  const saved = s.checkpoint();
  saved.view.trialDurationTicks = 35;
  saved.pendingFork = { parentId: 'root', ids: ['child'], actions: ['advance'], horizon: 70, actionTicks: 35 };
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async () => new FakeWorld('root'), async () => new FakeWorld('child'));
  assert.equal(restored.snapshot().worlds.find(w => w.id === 'child')!.trial?.total, 70);
  restored.step(); await restored.idle();
  assert.equal(restored.snapshot().worlds.find(w => w.id === 'child')!.state.tick, 105);
});

test('AI control filtering is per tick, fenced on pause, and never changes human input', async () => {
  const seen: number[] = [];
  const s = new Session({ decide: async () => ({ ...decision, confidence: 1 }) }, options);
  const main = new FakeWorld('controls');
  s.setControls(async (state, inputs) => { seen.push(state.tick); return inputs.filter(i => i !== 'forward'); });
  await s.initialize(main); s.setDecisionInterval(7);
  let stopping = false;
  s.on('change', () => { if (!stopping && s.snapshot().worlds.find(w => w.id === main.id)!.state.tick >= 42) { stopping = true; void s.pause(); } });
  s.resume(); await s.idle();
  assert.deepEqual(seen, [35, 36, 37, 38, 39, 40, 41]);
  assert.equal((await main.state()).x, 0);
  s.removeAllListeners('change');
  await s.takeover(main.id); await s.input(main.id, ['forward']);
  assert.equal((await main.state()).x, 7);
  assert.equal(seen.length, 7);
  await s.pause();

  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Session({ decide: async () => ({ ...decision, confidence: 1 }) }, options);
  const source = new FakeWorld('fenced-controls');
  delayed.setControls(async (_state, inputs) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return inputs; });
  await delayed.initialize(source); delayed.resume(); await entry;
  const pause = delayed.pause(); release(); await pause;
  assert.equal((await source.state()).tick, 35, 'no VM step after an aborted control lookup');
});

test('excluded actions cannot become alternate futures and previous action reaches Jev', async () => {
  const contexts: Array<string | undefined> = [];
  const s = new Session({ decide: async (_state, _objective, _history, _signal, _experience, _ticks, context) => {
    contexts.push(context?.previousAction);
    return { ...decision, perception: { profile: 'game-aware', blockedEnemies: 4, uncertainTargets: 1, forwardBarrier: 16, movementFailed: true, excludedActions: ['advance', 'fire'] } };
  } }, { ...options, horizon: 70 });
  await s.initialize(new FakeWorld('excluded')); s.step(); await s.idle();
  assert.ok(s.snapshot().worlds.filter(w => w.role === 'experiment').every(w => w.label !== actions.advance.label && w.label !== actions.fire.label));
  assert.equal(s.snapshot().decision?.perception?.blockedEnemies, 4);
  assert.ok(contexts.includes(actions.left.label));
  assert.ok(contexts.includes(actions.right.label));
});

function fakeCheckpoints() {
  const states = new Map<string, GameState>();
  const removed: string[] = [];
  return { states, removed, adapter: {
    capture: async (world: WorldRuntime, reference: string) => { states.set(reference, await world.state()); },
    restore: async (reference: string, id: string) => new FakeWorld(id, structuredClone(states.get(reference)!)),
    remove: async (reference: string) => { removed.push(reference); states.delete(reference); },
  } };
}
test('rollback restores timeline totals, keeps attempt history and experience, and collects newer checkpoints', async () => {
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new FakeWorld('root')); s.useExperience(true);
  await s.saveRecoveryCheckpoint(); const first = s.snapshot().recovery!.checkpoints[0]!.id;
  s.step(); await s.idle(); s.step(); await s.idle();
  const selected = s.snapshot(); assert.ok(selected.stats!.seconds > 0);
  await s.saveRecoveryCheckpoint();
  await s.rollback(first);
  const restored = s.snapshot();
  assert.equal(restored.worlds.find(w => w.id === restored.mainId)!.state.tick, 35);
  assert.equal(restored.stats!.seconds, 0);
  assert.equal(restored.stats!.attempts.seconds, selected.stats!.attempts.seconds);
  assert.equal(restored.stats!.attempts.rollbacks, 1);
  assert.equal(restored.experience!.stored, selected.experience!.stored);
  assert.equal(restored.recovery!.checkpoints.length, 1); assert.equal(c.removed.length, 1);
  assert.equal(restored.worlds.find(w => w.id === restored.mainId)!.parentId, 'root');
  assert.equal(restored.running, false);
});
test('poor batches retry unchanged source with other candidates then rollback and pause', async () => {
  class Dangerous extends FakeWorld {
    override async branch(ids: string[]) { return ids.map(id => new class extends FakeWorld {
      override async step(step: Step) { return { ...await super.step(step), health: 20 }; }
    }(id, structuredClone(initial))); }
  }
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  const main = new Dangerous('root'); s.setCheckpointAdapter(c.adapter); await s.initialize(main);
  s.setRecoveryPolicy({ enabled: true, maxRetries: 1, healthLoss: 15, stallSeconds: 15 });
  s.step(); await s.idle(); const opening = s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => w.label);
  s.step(); await s.idle();
  assert.equal(s.snapshot().mainId, 'root'); assert.equal((await main.state()).tick, 35);
  assert.equal(s.snapshot().stats!.attempts.retries, 1);
  s.step(); await s.idle();
  assert.notDeepEqual(s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => w.label), opening);
  s.step(); await s.idle();
  assert.notEqual(s.snapshot().mainId, 'root'); assert.equal(s.snapshot().stats!.health, 100);
  assert.equal(s.snapshot().stats!.attempts.rejectedBatches, 2);
  assert.equal(s.snapshot().stats!.attempts.rollbacks, 1); assert.equal(s.snapshot().error, undefined);
  assert.equal(s.snapshot().running, false);
});
test('checkpoint retention is bounded and restart removes checkpoint artifacts without resetting policy', async () => {
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new FakeWorld('root'));
  s.setRecoveryPolicy({ enabled: true, maxRetries: 3, healthLoss: 10, stallSeconds: 30 });
  for (let i = 0; i < 4; i++) await s.saveRecoveryCheckpoint();
  assert.equal(s.snapshot().recovery!.checkpoints.length, 3); assert.equal(c.states.size, 3);
  await s.restart(async () => new FakeWorld('fresh'), async () => {});
  assert.equal(c.states.size, 0); assert.equal(s.snapshot().recovery!.checkpoints.length, 0);
  assert.equal(s.snapshot().recovery!.policy.maxRetries, 3);
  assert.equal(s.snapshot().stats!.attempts.rollbacks, 0);
});
test('failed checkpoint restore preserves the current run and journals recovery', async () => {
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new FakeWorld('root')); await s.saveRecoveryCheckpoint();
  const id = s.snapshot().recovery!.checkpoints[0]!.id;
  s.setCheckpointAdapter({ ...c.adapter, restore: async () => { throw new Error('restore unavailable'); } });
  await assert.rejects(s.rollback(id), /restore unavailable/);
  assert.equal(s.snapshot().mainId, 'root'); assert.ok(s.checkpoint().recovery!.pendingRestore);
  const recovered = new Session({ decide: async () => decision }, options); recovered.setCheckpointAdapter(c.adapter);
  await recovered.restore(s.checkpoint(), async id => new FakeWorld(id), async () => undefined);
  assert.equal(recovered.snapshot().mainId, 'root'); assert.equal(recovered.checkpoint().recovery!.pendingRestore, undefined);
});
test('interrupted restore adopts its exact child and preserves original checkpoint totals', async () => {
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new FakeWorld('root')); await s.saveRecoveryCheckpoint();
  const saved = s.checkpoint(), point = saved.recovery!.points[0]!;
  saved.recovery!.pendingRestore = { id: 'recovered-child', pointId: point.id };
  const recovered = new Session({ decide: async () => decision }, options); recovered.setCheckpointAdapter(c.adapter);
  await recovered.restore(saved, async id => new FakeWorld(id), async id => new FakeWorld(id), async () => {});
  assert.equal(recovered.snapshot().mainId, 'recovered-child');
  assert.equal(recovered.snapshot().stats!.attempts.rollbacks, 1);
  assert.equal(recovered.checkpoint().recovery!.pendingRestore, undefined);
});

test('recovery prefers a healthy future over a higher-scoring but unacceptable kill trade', async () => {
  class Mixed extends FakeWorld {
    override async branch(ids: string[]) { return ids.map((id, i) => new class extends FakeWorld {
      override async step(step: Step) { return { ...await super.step(step), health: i === 0 ? 20 : 100, kills: i === 0 ? 100 : 0 }; }
    }(id)); }
  }
  const s = new Session({ decide: async () => ({ ...decision, priority: 'combat' }) }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new Mixed('root'));
  s.setRecoveryPolicy({ enabled: true, maxRetries: 1, healthLoss: 15, stallSeconds: 15 });
  s.step(); await s.idle(); const selected = s.snapshot().comparison!.bestId;
  assert.equal(s.snapshot().worlds.find(w => w.id === selected)!.state.health, 100);
  s.step(); await s.idle();
  assert.equal(s.snapshot().mainId, selected); assert.equal(s.snapshot().stats!.attempts.retries, 0);
  assert.equal(s.snapshot().stats!.kills, 0); assert.ok(s.snapshot().stats!.attempts.kills > 0);
});
test('interrupted capture is collected without losing the main world', async () => {
  const s = new Session({ decide: async () => decision }, options), c = fakeCheckpoints();
  s.setCheckpointAdapter(c.adapter); await s.initialize(new FakeWorld('root'));
  const saved = s.checkpoint(); saved.recovery!.pendingCapture = 'owned-interrupted:recovery';
  c.states.set('owned-interrupted:recovery', initial);
  const restored = new Session({ decide: async () => decision }, options); restored.setCheckpointAdapter(c.adapter);
  await restored.restore(saved, async id => new FakeWorld(id));
  assert.equal(c.states.size, 0); assert.equal(restored.snapshot().mainId, 'root');
  assert.equal(restored.checkpoint().recovery!.pendingCapture, undefined);
});

test('trial kill deltas stay positive through a map counter reset and promotion preserves cumulative kills', async () => {
  class MapChange extends FakeWorld {
    override async branch(ids: string[]) { return ids.map(id => new class extends FakeWorld {
      override async step(step: Step) { return { ...await super.step(step), map: 2, kills: 1 }; }
    }(id, { ...structuredClone(initial), kills: 5 })); }
  }
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(new MapChange('root', { ...structuredClone(initial), kills: 5 }));
  s.useExperience(true); s.step(); await s.idle();
  assert.deepEqual(s.snapshot().worlds.filter(w => w.role === 'experiment').map(w => w.trial!.kills), [1, 1]);
  assert.ok(s.checkpoint().experience!.records.every(e => e.result.kills === 1));
  assert.equal(s.snapshot().stats!.kills, 5);
  s.step(); await s.idle();
  assert.equal(s.snapshot().stats!.kills, 6);
  assert.equal(s.snapshot().worlds.find(w => w.id === s.snapshot().mainId)!.state.kills, 1);
});

test('motor recovery memory is persisted and forks copy it without sharing mutations', async () => {
  const main = new FakeWorld('root');
  const s = new Session({ decide: async () => decision }, options);
  await s.initialize(main);
  const saved = s.checkpoint();
  saved.worlds[0]!.navigation = { stalled: 3 };
  const restored = new Session({ decide: async () => decision }, options);
  await restored.restore(saved, async () => main);
  assert.deepEqual(restored.checkpoint().worlds[0]!.navigation, { stalled: 3 });
  restored.setControls(async (_state, inputs, memory) => { memory.stalled = (memory.stalled ?? 0) + 1; return inputs; });
  restored.step(); await restored.idle();
  const worlds = restored.checkpoint().worlds;
  assert.equal(worlds.find(w => w.view.id === 'root')!.navigation!.stalled, 3);
  const children = worlds.filter(w => w.view.role === 'experiment');
  assert.equal(children.length, 2);
  for (const child of children) assert.equal(child.navigation!.stalled, 17);
  children[0]!.navigation!.stalled = 99;
  assert.equal(restored.checkpoint().worlds.find(w => w.view.id === children[0]!.view.id)!.navigation!.stalled, 17);
});

test('conditional plans span action intervals and record step progress through the comparison horizon', async () => {
  let calls = 0;
  const { candidatePlans } = await import('./doom-plans.ts');
  const { DoomMap } = await import('./doom-geometry.ts');
  const plans = candidatePlans(initial, new DoomMap([])).slice(0, 2).map(p => ({ ...p, probability: .5 }));
  const s = new Session({ decide: async (_s, _o, _h, _sig, _e, _t, context) => {
    calls++; assert.equal(context?.planTicks, 21);
    return { ...decision, plans: { selected: plans[0]!.id, candidates: plans } };
  } }, { ...options, horizon: 21 });
  s.setDecisionInterval(7);
  const main = new FakeWorld('plans-root');
  const recorded: Array<{ status: string; step: number; tick: number }> = [];
  s.setRecorder(async w => { if (w.plan) recorded.push({ status: w.plan.status, step: w.plan.step, tick: w.state.tick }); });
  await s.initialize(main); s.step(); await s.idle();
  assert.equal(s.snapshot().error, undefined);
  assert.equal(calls, 1, 'one Jev judgment launches two plans, no fixed-interval replanning');
  assert.equal((await main.state()).tick, 35);
  const children = s.snapshot().worlds.filter(w => w.role === 'experiment');
  assert.equal(children.length, 2);
  assert.ok(children.every(w => w.state.tick === 56 && w.plan?.status === 'horizon'));
  assert.ok(recorded.some(r => r.step === 1));
  assert.ok(recorded.some(r => r.tick === 56 && r.status === 'horizon'));
  assert.equal(s.snapshot().decision?.kind, 'plan');
});

test('paused direct plans survive reconnect and continue without another model call', async () => {
  const { candidatePlans } = await import('./doom-plans.ts');
  const { DoomMap } = await import('./doom-geometry.ts');
  const plan = { ...candidatePlans(initial, new DoomMap([]))[0]!, probability: 1 };
  let calls = 0;
  const decider = { decide: async () => { calls++; return { ...decision, confidence: 1, plans: { selected: plan.id, candidates: [plan] } }; } };
  const main = new FakeWorld('direct-plan');
  const s = new Session(decider, { ...options, horizon: 70 });
  await s.initialize(main);
  let paused = false;
  s.on('change', view => { if (!paused && view.worlds[0]?.state.tick >= 42) { paused = true; void s.pause(); } });
  // resume uses confidence routing; step deliberately forces a comparison.
  s.resume(); await s.idle();
  const saved = s.checkpoint(); assert.equal(saved.worlds[0]!.plan?.status, 'running');
  const resumed = new Session(decider, { ...options, horizon: 70 });
  await resumed.restore(saved, async () => main);
  assert.deepEqual(resumed.checkpoint().worlds[0]!.plan, saved.worlds[0]!.plan);
  let finished = false;
  resumed.on('change', view => { if (!finished && view.worlds[0]?.state.tick >= 105) { finished = true; void resumed.pause(); } });
  resumed.resume(); await resumed.idle();
  assert.equal(calls, 1);
  assert.equal((await main.state()).tick, 105);
  assert.equal(resumed.snapshot().worlds[0]!.plan?.status, 'horizon');
  await resumed.takeover(main.id);
  assert.equal(resumed.checkpoint().worlds[0]!.plan, undefined);
});

test('fork threshold and memory settings persist and change routing without resetting gameplay', async () => {
  const decider = { decide: async () => ({ ...decision, confidence: .8 }) };
  const main = new FakeWorld('tunable');
  const s = new Session(decider, options); await s.initialize(main);
  s.setForkThreshold(.9); s.configureMemory(256, 6);
  const saved = s.checkpoint();
  const recovered = new Session(decider, options); await recovered.restore(saved, async () => main);
  assert.equal(recovered.snapshot().forkThreshold, .9);
  assert.equal(recovered.snapshot().experience?.capacity, 256);
  assert.equal(recovered.snapshot().experience?.contextLimit, 6);
  let stopped = false;
  recovered.on('change', v => { if (!stopped && v.stage === 'choosing') { stopped = true; void recovered.pause(); } });
  recovered.resume(); await recovered.idle();
  assert.equal(recovered.snapshot().decision?.mode, 'uncertain');
  assert.equal(recovered.snapshot().decision?.threshold, .9);
  assert.equal((await main.state()).tick, initial.tick);
  assert.throws(() => recovered.setForkThreshold(1.1));
  assert.throws(() => recovered.configureMemory(128, 9));
});

test('new guide replaces an in-flight future judgment and every request includes world statistics', async () => {
  const seen: string[] = [];
  let s!: Session, changed = false;
  const decider: DecisionMaker = { decide: async (state, objective, _history, _signal, _experience, _ticks, context) => {
    assert.equal(context?.stats?.current.tick, state.tick);
    assert.equal(context?.stats?.current.health, state.health);
    assert.equal(context?.stats?.current.mapKills, state.kills);
    assert.ok(context?.visited?.length);
    seen.push(objective);
    if (state.tick > initial.tick && !changed) { changed = true; s.queueObjective('collect health before fighting'); }
    return decision;
  } };
  s = new Session(decider, { ...options, horizon: 70 });
  await s.initialize(new FakeWorld('guide')); s.step(); await s.idle();
  assert.equal(s.snapshot().error, undefined);
  assert.ok(changed); assert.ok(seen.includes('collect health before fighting'));
  assert.equal(s.snapshot().objective, 'collect health before fighting');
  assert.equal(s.snapshot().pendingObjective, undefined);
});

test('stalled progress forces a labelled comparison despite high confidence and movement alone earns no score', async () => {
  const { outcomeScore } = await import('./session.ts');
  assert.equal(outcomeScore(initial, { ...initial, x: 500 }, 'exploration'), 0);
  assert.ok(outcomeScore(initial, { ...initial, x: 50 }, 'exploration', 2) > 0);
  const game = { ...initial, tick: initial.tick + 350 };
  const main = new FakeWorld('stalled', game), decider = { decide: async () => ({ ...decision, confidence: 1 }) };
  const s = new Session(decider, options); await s.initialize(main);
  const saved = s.checkpoint(); saved.worlds[0]!.stats!.lastProgressTick = initial.tick;
  const restored = new Session(decider, options); await restored.restore(saved, async () => main);
  let paused = false; restored.on('change', v => { if (!paused && v.stage === 'choosing') { paused = true; void restored.pause(); } });
  restored.resume(); await restored.idle();
  assert.equal(restored.snapshot().decision?.mode, 'stalled');
  assert.equal(restored.snapshot().routing?.stalled, 1);
});

test('pickup knowledge follows forks, restart and checkpoint rollback without sibling aliasing', async () => {
  const rootState = { ...initial, pickups: [{ kind: 'pickup' as const, engineType: 54, health: 1000,
    position: { x: 128, y: 0, z: 0 }, distance: 128, relativeBearing: 0, heading: 0,
    direction: { x: 0, y: 0 }, towardPlayerAlignment: 0 }] };
  const source = new FakeWorld('pickup-root', rootState), c = fakeCheckpoints();
  const s = new Session({ decide: async () => decision }, options);
  s.setCheckpointAdapter(c.adapter); await s.initialize(source); await s.saveRecoveryCheckpoint();
  const point = s.snapshot().recovery!.checkpoints[0]!.id;
  s.step(); await s.idle();
  const saved = s.checkpoint(), root = saved.worlds.find(w => w.view.id === 'pickup-root')!;
  const children = saved.worlds.filter(w => w.view.role === 'experiment');
  assert.equal(children.length, 2);
  assert.deepEqual(children[0]!.pickups?.entries.map(p => p.engineType), [54]);
  children[0]!.pickups!.entries[0]!.x = 9000;
  assert.equal(root.pickups!.entries[0]!.x, 128); assert.equal(children[1]!.pickups!.entries[0]!.x, 128);
  assert.equal(s.checkpoint().worlds.find(w => w.view.id === children[0]!.view.id)!.pickups!.entries[0]!.x, 128);
  const recovered = new Session({ decide: async () => decision }, options);
  recovered.setCheckpointAdapter(c.adapter);
  await recovered.restore(s.checkpoint(), async id => new FakeWorld(id, s.snapshot().worlds.find(w => w.id === id)!.state));
  assert.deepEqual(recovered.checkpoint().worlds.find(w => w.view.id === 'pickup-root')!.pickups, root.pickups);
  await recovered.rollback(point);
  const restored = recovered.checkpoint().worlds.find(w => w.view.id === recovered.snapshot().mainId)!;
  assert.deepEqual(restored.pickups, root.pickups);
});

test('skill registry validates atomically, survives reconnect and restart, and sends only current revisions', async () => {
  let s!: Session, updated = false;
  const seen: string[][] = [];
  const decider: DecisionMaker = { decide: async (state, _objective, _history, _signal, _experience, _ticks, context) => {
    seen.push(context?.skills?.filter(s => s.enabled).map(s => s.instructions) ?? []);
    if (state.tick > initial.tick && !updated) { updated = true; s.saveSkill({ name: 'Escape', instructions: 'Find a new route.', enabled: true }, s.snapshot().skills![0]!.id); }
    return decision;
  } };
  s = new Session(decider, { ...options, horizon: 70 }); await s.initialize(new FakeWorld('skills'));
  s.saveSkill({ name: 'Escape', instructions: 'Avoid blocked walls.', enabled: true });
  const id = s.snapshot().skills![0]!.id;
  const before = s.checkpoint();
  assert.throws(() => s.saveSkill({ name: 'escape', instructions: 'Duplicate', enabled: true }), /unique name/);
  assert.throws(() => s.saveSkill({ name: 'Oversized', instructions: 'x'.repeat(2001), enabled: true }));
  s.saveSkill({ name: 'Large', instructions: 'x'.repeat(1900), enabled: false });
  const other = s.snapshot().skills![1]!.id;
  s.toggleSkill(other, true);
  assert.throws(() => s.saveSkill({ name: 'Too much', instructions: 'x'.repeat(1000), enabled: true }), /context budget/);
  s.toggleSkill(other, false);
  s.step(); await s.idle();
  assert.equal(s.snapshot().error, undefined); assert.ok(updated);
  assert.ok(seen.some(list => list.includes('Find a new route.')));
  assert.ok(seen.every(list => !list.includes('x'.repeat(1900))));
  const recovered = new Session(decider, options);
  await recovered.restore(s.checkpoint(), async id => new FakeWorld(id, s.snapshot().worlds.find(w => w.id === id)!.state));
  assert.deepEqual(recovered.snapshot().skills, s.snapshot().skills);
  await recovered.restart(async () => new FakeWorld('fresh-skills'), async () => {});
  assert.deepEqual(recovered.snapshot().skills, s.snapshot().skills);
  recovered.deleteSkill(id); assert.equal(recovered.snapshot().skills!.length, 1);
  assert.throws(() => recovered.toggleSkill(id, true), /not found/);
  const old = new Session(decider, options); delete before.view.skills; delete before.view.skillsRevision;
  await old.restore(before, async () => new FakeWorld('skills'));
  assert.deepEqual(old.snapshot().skills, []);
});

test('changing enabled skills during a judgment discards it before branching', async () => {
  let s!: Session, calls = 0;
  const decider: DecisionMaker = { decide: async (_state, _objective, _history, _signal, _experience, _ticks, context) => {
    calls++;
    if (calls === 1) { assert.equal(context!.skills!.length, 0); s.saveSkill({ name: 'New tactic', instructions: 'Find a safe route.', enabled: true }); }
    else assert.equal(context!.skills![0]!.name, 'New tactic');
    return decision;
  } };
  s = new Session(decider, options); await s.initialize(new FakeWorld('skill-race'));
  s.step(); await s.idle();
  assert.equal(calls, 2); assert.equal(s.snapshot().error, undefined);
});

test('skill edits invalidate saved plans on checkpoint rollback', async () => {
  const plan = { id: 'explore', label: 'explore', steps: [{ kind: 'move' as const, label: 'move', target: { kind: 'point' as const, x: 1000, y: 0, z: 0 }, maxTicks: 140 }] };
  let calls = 0;
  const decider: DecisionMaker = { decide: async () => { calls++; return { ...decision, confidence: 1, plans: { selected: plan.id, candidates: [{ ...plan, probability: 1 }] } }; } };
  const s = new Session(decider, { ...options, horizon: 70 }); await s.initialize(new FakeWorld('skill-plan'));
  let paused = false;
  s.on('change', view => { if (!paused && view.worlds[0]!.state.tick >= 42) { paused = true; void s.pause(); } });
  s.resume(); await s.idle();
  const saved = s.checkpoint(); assert.equal(saved.worlds[0]!.plan!.status, 'running');
  s.saveSkill({ name: 'Replan', instructions: 'Choose another route.', enabled: true });
  const current = s.checkpoint();
  // Simulate restoring a world checkpoint whose plan predates the registry edit.
  current.worlds[0]!.plan = saved.worlds[0]!.plan;
  const restored = new Session(decider, { ...options, horizon: 70 });
  await restored.restore(current, async () => new FakeWorld('skill-plan', current.worlds[0]!.view.state));
  let stopped = false; restored.on('change', view => { if (!stopped && view.worlds[0]!.state.tick >= 49) { stopped = true; void restored.pause(); } });
  restored.resume(); await restored.idle();
  assert.equal(calls, 2); assert.equal(restored.snapshot().error, undefined);
});
test('nearby locked doors do not replace the guide, switch action mode or reserve a candidate', async () => {
  const root = new FakeWorld('root', { ...initial, keys: [], map: 2, x: 1207.98, y: -207.94, z: -8 });
  const decider: DecisionMaker = { decide: async (_state, objective, _history, _signal, _experience, _ticks, context) => {
    assert.equal(objective, 'Avoid combat and explore other rooms.');
    assert.equal(context?.planTicks, undefined);
    assert.equal('objectivePlan' in context!, false); assert.equal('navigationObjective' in context!, false);
    assert.deepEqual(context?.stats?.current.keys, []);
    return decision;
  } };
  const session = new Session(decider, options); await session.initialize(root);
  session.setPlanningMode('actions'); session.queueObjective('Avoid combat and explore other rooms.');
  session.step(); await session.idle();
  assert.equal(session.snapshot().error, undefined);
  assert.equal(session.snapshot().objective, 'Avoid combat and explore other rooms.');
  assert.ok(session.checkpoint().worlds.every(w => !('progression' in w) && !('navigationGoal' in w.view)));
});
test('reconnect and rollback retire saved key strategy without losing gameplay or the user guide', async () => {
  const { startPlan } = await import('./doom-plans.ts');
  const { discardForcedKeyStrategy } = await import('./session-policy-upgrade.ts');
  const root = new FakeWorld('root'); const session = new Session({ decide: async () => decision }, options);
  await session.initialize(root);session.step();await session.idle();
  const saved: any = session.checkpoint();saved.view.objective='Explore freely.';
  const forced: any = { id:'key-route',family:'progression',label:'find the red key',steps:[{kind:'move',target:{kind:'point',x:100,y:0,z:0},label:'follow key route',maxTicks:140}] };
  for(const record of saved.worlds){
    record.progression={goal:{key:'red',phase:'find-key'}};
    record.plan=startPlan(forced,record.view.state,210);
    record.view.navigationGoal={key:'red',phase:'find-key',label:forced.label};
    record.view.plan={label:forced.label,steps:['follow key route'],step:0,status:'running'};
    if(record.view.trial){record.view.trial.goalProgress=40;record.view.score=100;}
  }
  const rootRecord=saved.worlds[0];
  saved.recovery.points=[{...structuredClone(rootRecord),id:'cp',reference:'test:cp',createdAt:1,world:structuredClone(rootRecord.view)}];
  saved.view.worlds=saved.worlds.map((r:any)=>structuredClone(r.view));
  const pending=structuredClone(saved);pending.pendingFork={parentId:'root',ids:['pending'],actions:['advance'],plans:[forced]};
  const cleaned=discardForcedKeyStrategy(pending);
  assert.deepEqual(cleaned.pendingFork?.plans,[undefined]);assert.equal(cleaned.pendingFork?.skillsRevision,-1);
  assert.equal(cleaned.worlds[1]!.view.score,60);
  assert.equal(cleaned.experiments[0]!.nextDecisionTick,cleaned.worlds[1]!.view.state.tick);
  assert.ok(!('progression' in cleaned.recovery!.points[0]!));assert.equal(cleaned.recovery!.points[0]!.plan,undefined);
  assert.equal(saved.worlds[0].plan.plan.id,'key-route'); // Caller data is not mutated.
  const restored=new Session({decide:async()=>decision},options);
  restored.setCheckpointAdapter({capture:async()=>{},remove:async()=>{},restore:async(_reference,id)=>new FakeWorld(id,rootRecord.view.state)});
  await restored.restore(saved,async(id)=>new FakeWorld(id,saved.worlds.find((r:any)=>r.view.id===id).view.state));
  assert.equal(restored.snapshot().objective,'Explore freely.');
  for(const record of restored.checkpoint().worlds){assert.equal(record.plan,undefined);assert.ok(!('navigationGoal' in record.view));}
  await restored.rollback('cp');
  assert.equal(restored.snapshot().objective,'Explore freely.');
  const main=restored.checkpoint().worlds.find(w=>w.view.id===restored.snapshot().mainId)!;
  assert.deepEqual(main.view.state,rootRecord.view.state);assert.equal(main.plan,undefined);assert.ok(!('progression' in main));
});
