import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStream } from './session-stream.ts';
import { applySessionUpdate } from '../../../packages/contracts/src/session-stream.ts';
import { Session } from './session.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

test('incremental delivery retains unchanged worlds and removes expired worlds and optional fields', async () => {
  const game = new Session({ decide: async () => decision });
  await game.initialize(new Runtime('root'));
  const first = game.snapshot();
  first.error = 'old error';
  first.worlds.push({ ...structuredClone(first.worlds[0]!), id: 'archived', role: 'archived' });
  const stream = new SessionStream(first);
  const next = structuredClone(first);
  delete next.error;
  next.worlds[0]!.frameVersion++;
  const update = stream.update(next);
  assert.equal(update.worlds.length, 1);
  const reconstructed = applySessionUpdate(first, update);
  assert.deepEqual(reconstructed, next);
  assert.equal(reconstructed.worlds[1], first.worlds[1]);
  assert.equal(stream.update(next).worlds.length, 0);
  const final = structuredClone(next);
  final.worlds = [final.worlds[0]!];
  assert.deepEqual(applySessionUpdate(reconstructed, stream.update(final)), final);
  // Each new connection receives its own full view/cursor, including late joiners.
  assert.equal(new SessionStream(final).update(final).worlds.length, 0);
});

test('session patches preserve exact wire state through frame, decision, removal and reconnect updates', async () => {
  const game = new Session({ decide: async () => decision });
  await game.initialize(new Runtime('root'));
  const wire = (view: ReturnType<Session['snapshot']>) => JSON.parse(JSON.stringify(view)) as typeof view;
  let current = wire(game.snapshot()), received = current;
  const stream = new SessionStream(current, 'patches');
  const oldClient = new SessionStream(current);
  let oldReceived = current;
  const updates: Array<(view: typeof current) => void> = [
    view => { view.error = 'temporary failure'; },
    view => { view.worlds[0]!.frameVersion++; view.worlds[0]!.state.health--; },
    view => { view.objective = 'Reach the exit'; view.running = true; },
    view => { delete view.error; view.worlds.push({ ...structuredClone(view.worlds[0]!), id: 'future', role: 'experiment' }); },
    view => { view.worlds.reverse(); view.mainId = 'future'; },
    view => { view.worlds = view.worlds.filter(world => world.id === 'future'); view.running = false; },
  ];
  for (const mutate of updates) {
    current = structuredClone(current); mutate(current); current = wire(current);
    received = applySessionUpdate(received, JSON.parse(JSON.stringify(stream.update(current))));
    oldReceived = applySessionUpdate(oldReceived, JSON.parse(JSON.stringify(oldClient.update(current))));
    assert.deepEqual(received, current); assert.deepEqual(oldReceived, current);
  }
  const reconnected = new SessionStream(current, 'patches');
  const unchanged = reconnected.update(current);
  assert.equal(unchanged.type, 'session-patch');
  assert.deepEqual(unchanged.session, {}); assert.deepEqual(unchanged.worlds, []);
  assert.deepEqual(applySessionUpdate(current, unchanged), current);
});

test('frame-only patches do not resend commentary or replace unchanged sidebar values', async () => {
  const game = new Session({ decide: async () => decision });
  await game.initialize(new Runtime('root'));
  const current = game.snapshot();
  // A realistic long-lived session retains commentary across many frame updates.
  current.objective = 'A long instruction. '.repeat(1000);
  const next = structuredClone(current); next.worlds[0]!.frameVersion++;
  const patch = new SessionStream(current, 'patches').update(next);
  const legacy = new SessionStream(current).update(next);
  assert.deepEqual(patch.session, {});
  assert.ok(JSON.stringify(patch).length < JSON.stringify(legacy).length / 2);
  const received = applySessionUpdate(current, patch);
  assert.deepEqual(received, next);
  assert.equal(received.commentary, current.commentary);
  assert.equal(received.skills, current.skills);
});
