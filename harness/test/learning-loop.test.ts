import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningLoop, type LearningLoopPorts, type BatchPhase } from '../src/learning-loop.ts';
import { WorldLifecycle, type WorldMetadata } from '../src/world-lifecycle.ts';
import { runTrials } from '../src/trials.ts';

type Candidate = { probability: number; move: number };
type Limits = { breadth: number; turns: number };
class Runtime {
  readonly identity: string;
  state = { turn: 0, points: 0, moves: [] as number[] };
  removed = false;
  constructor(readonly id: string) { this.identity = `physical:${id}`; }
  fork(id: string) { const child = new Runtime(id); child.state = structuredClone(this.state); return child; }
  move(value: number) { this.state.turn++; this.state.points += value; this.state.moves.push(value); }
  async destroy() { this.removed = true; }
}
type World = { meta: WorldMetadata; runtime?: Runtime };
function fixture() {
  const events: string[] = [];
  let phase: BatchPhase = 'none';
  let batch: Array<{ world: World; move: number; baseline: number; turns: number }> = [];
  let checkpoint: Runtime['state'] | undefined;
  let continuation = false, rejected = false, confidence = 0.2, retries = 0;
  let serial = 0;
  const limits: Limits = { breadth: 2, turns: 3 };
  const root = new Runtime('root');
  const wrap = (runtime: Runtime, role: WorldMetadata['role']): World => ({ runtime, meta: { id: runtime.id, role, status: 'paused', controller: 'ai' } });
  const lifecycle = new WorldLifecycle<World, Runtime>({
    metadata: w => w.meta,
    persist: async () => { events.push(`persist:${lifecycle.mainId}`); },
    stageSelection: () => {
      const old = phase; phase = 'none';
      return () => { phase = old; };
    },
  });
  lifecycle.register(wrap(root, 'main')); lifecycle.mainId = root.id;
  const ports: LearningLoopPorts<World, Candidate, number, Limits> = {
    state: {
      main: () => lifecycle.world(lifecycle.mainId),
      terminal: w => w.runtime!.state.turn >= 5,
      batch: () => phase,
    },
    planning: {
      prepare: (_w, manual) => { events.push('prepare'); if (manual) continuation = false; },
      continuing: () => continuation,
      continue: async w => { events.push('continue'); w.runtime!.move(1); },
      limits: () => limits,
      decide: async w => {
        events.push('decide');
        return { confidence, candidates: [{ probability: 0.7, move: 1 }, { probability: 0.3, move: -1 }], data: w.runtime!.state.turn };
      },
      routing: () => ({ threshold: 0.75, stalled: false, retries }),
      execute: async w => { events.push('execute'); w.runtime!.move(1); },
    },
    comparison: {
      create: async (source, candidates, judgment, pinned) => {
        events.push('fork');
        batch = candidates.map(candidate => {
          const world = wrap(source.runtime!.fork(`child-${serial++}`), 'experiment');
          lifecycle.register(world);
          return { world, move: candidate.move, baseline: judgment.data, turns: pinned.turns };
        });
        phase = 'exploring';
      },
      explore: async signal => {
        events.push('explore');
        await runTrials(batch.map(entry => ({
          id: entry.world.meta.id,
          baseline: { sequence: entry.baseline, elapsed: entry.baseline, unit: 'turns' as const },
          duration: { amount: entry.turns, unit: 'turns' as const },
          clock: () => ({ sequence: entry.world.runtime!.state.turn, elapsed: entry.world.runtime!.state.turn, unit: 'turns' as const }),
          terminal: () => false,
          advance: async () => { entry.world.runtime!.move(entry.move); },
        })), signal);
        if (!signal.aborted) phase = 'complete';
      },
      evaluate: () => ({ winner: [...batch].sort((a, b) => b.world.runtime!.state.points - a.world.runtime!.state.points)[0]?.world, rejected }),
      promote: async w => { events.push('promote'); await lifecycle.promote(w.meta.id); },
      review: async () => { events.push('review'); },
      afterPromotion: async () => { events.push('afterPromotion'); },
    },
    recovery: {
      checkpointNeeded: () => !checkpoint,
      checkpoint: async () => { events.push('checkpoint'); checkpoint = structuredClone(lifecycle.world(lifecycle.mainId).runtime!.state); },
      terminal: async w => { events.push('terminal'); w.runtime!.state = structuredClone(checkpoint!); },
      reject: async () => { events.push('reject'); retries++; await lifecycle.promote(lifecycle.mainId); },
    },
    observe: { stage: stage => { events.push(`stage:${stage}`); } },
  };
  return { ports, loop: new LearningLoop(ports), events, limits, root, lifecycle, batch: () => batch,
    configure: (values: { continuation?: boolean; rejected?: boolean; confidence?: number }) => {
      continuation = values.continuation ?? continuation; rejected = values.rejected ?? rejected; confidence = values.confidence ?? confidence;
    } };
}
const signal = () => new AbortController().signal;

test('shared loop explores equal turn budgets, promotes the whole winning state, continues and recovers', async () => {
  const f = fixture();
  assert.equal(await f.loop.cycle(signal()), 'advanced');
  assert.ok(f.events.indexOf('checkpoint') < f.events.indexOf('decide'));
  assert.deepEqual(f.root.state, { turn: 0, points: 0, moves: [] });
  assert.deepEqual(f.batch().map(b => b.world.runtime!.state), [
    { turn: 3, points: 3, moves: [1, 1, 1] }, { turn: 3, points: -3, moves: [-1, -1, -1] },
  ]);
  const winner = f.batch()[0]!.world.runtime!;
  await f.loop.cycle(signal());
  assert.equal(f.lifecycle.mainId, winner.id);
  assert.equal(f.lifecycle.world(winner.id).runtime, winner);
  assert.equal(f.root.removed, true);
  assert.ok(f.events.indexOf('review') < f.events.indexOf('promote'));
  f.configure({ confidence: 0.9 });
  await f.loop.cycle(signal());
  assert.equal(winner.state.turn, 4);
  f.configure({ continuation: true });
  const decisions = f.events.filter(e => e === 'decide').length;
  await f.loop.cycle(signal());
  assert.equal(winner.state.turn, 5);
  assert.equal(f.events.filter(e => e === 'decide').length, decisions);
  assert.equal(await f.loop.cycle(signal()), 'stopped');
  assert.deepEqual(winner.state, { turn: 0, points: 0, moves: [] });
});

test('rejected trial outcomes retain the source and rotate the next candidate batch', async () => {
  const f = fixture(); f.limits.breadth = 1;
  await f.loop.cycle(signal());
  f.configure({ rejected: true });
  await f.loop.cycle(signal());
  assert.equal(f.lifecycle.mainId, f.root.id);
  assert.equal(f.root.removed, false);
  assert.equal(f.events.includes('review'), false);
  assert.equal(f.events.includes('promote'), false);
  await f.loop.cycle(signal());
  assert.equal(f.batch()[0]!.move, -1);
});

test('manual comparison invalidates a continuation, ignores confidence and skips presentation delay', async () => {
  const f = fixture(); f.configure({ continuation: true, confidence: 1 });
  await f.loop.cycle(signal(), true);
  assert.equal(f.events.includes('continue'), false);
  assert.equal(f.batch().length, 2);
  await f.loop.cycle(signal(), true);
  assert.equal(f.events.includes('review'), false);
  assert.equal(f.events.includes('afterPromotion'), false);
  assert.equal(f.events.includes('promote'), true);
});

test('limits remain pinned across a pending provider judgment', async () => {
  const f = fixture();
  const decide = f.ports.planning.decide;
  f.ports.planning.decide = async (...args) => {
    f.limits.breadth = 1; f.limits.turns = 9;
    return decide(...args);
  };
  await f.loop.cycle(signal());
  assert.equal(f.batch().length, 2);
  assert.deepEqual(f.batch().map(b => b.world.runtime!.state.turn), [3, 3]);
});

for (const boundary of ['checkpoint', 'decide', 'stage:forking', 'review'] as const) {
  test(`cancellation at ${boundary} prevents the next runtime mutation`, async () => {
    const f = fixture(), control = new AbortController();
    if (boundary === 'review') {
      await f.loop.cycle(signal());
      f.ports.comparison.review = async () => { control.abort(); };
    } else if (boundary === 'checkpoint') {
      f.ports.recovery.checkpoint = async () => { control.abort(); };
    } else if (boundary === 'decide') {
      const decide = f.ports.planning.decide;
      f.ports.planning.decide = async (...args) => { const result = await decide(...args); control.abort(); return result; };
    } else {
      f.ports.observe!.stage = stage => { if (`stage:${stage}` === boundary) control.abort(); };
    }
    assert.equal(await f.loop.cycle(control.signal), 'cancelled');
    assert.equal(f.lifecycle.mainId, f.root.id);
    assert.equal(f.root.removed, false);
    assert.equal(f.events.includes('promote'), false);
    if (boundary !== 'review') assert.equal(f.batch().length, 0);
    if (boundary === 'checkpoint') assert.equal(f.events.includes('decide'), false);
  });
}

test('provider and trial errors propagate without promotion or hidden retries', async () => {
  for (const where of ['decide', 'explore'] as const) {
    const f = fixture();
    const failure = new Error(where);
    if (where === 'decide') f.ports.planning.decide = async () => { throw failure; };
    else f.ports.comparison.explore = async () => { throw failure; };
    await assert.rejects(f.loop.cycle(signal()), error => error === failure);
    assert.equal(f.lifecycle.mainId, f.root.id);
    assert.equal(f.root.removed, false);
    assert.equal(f.events.includes('promote'), false);
  }
});
