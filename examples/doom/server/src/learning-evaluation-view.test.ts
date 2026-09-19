import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { LearningEvaluationReader } from './learning-evaluation-view.ts';
import { openDoomEvaluationRecording } from './doom-evaluation-recording.ts';
import type { SessionView, WorldView } from '../../contracts/src/session.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'evaluation-preview-')), id = randomUUID();
  const reader = new LearningEvaluationReader(directory);
  const write = async (path: string, value: unknown) => { const file = join(directory, id, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  const run = (role: string, scenario = 'start-0') => 'runs/' + contentRevision('doom-evaluation-run', `test/${scenario}/${role}`).version.slice(7);
  await write('manifest.json', { contract: { id: 'test', scenarios: [{ id: 'start-0' }, { id: 'start-1' }] } });
  const saved = (frame = 'first frame') => ({
    view: { stage: 'exploring', stats: { health: 80, armor: 10, kills: 4, items: 2, cells: 5, seconds: 12, damage: 20 } },
    worlds: ['main', 'experiment', 'archived'].map((role, i) => ({ view: { id: `world-${i}`, label: role, role, state: { tick: 420, health: 80, kills: 4 } }, frame: Buffer.from(frame + i).toString('base64'), history: ['private model data'] })),
    learning: { private: 'not for spectator' },
  });
  return { directory, reader, id, write, run, saved, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('spectator follows durable progress and frames without exposing private learning input', async () => {
  const f = await fixture();
  try {
    let view = await f.reader.view(f.id, true);
    assert.equal(view.total, 4); assert.equal(view.finished, 0); assert.ok(view.runs.every(run => run.status === 'waiting'));
    await f.write(f.run('baseline') + '/budget.json', { entries: [] });
    view = await f.reader.view(f.id, true); assert.equal(view.runs[0]!.status, 'running');
    await f.write(f.run('baseline') + '/session.json', f.saved());
    view = await f.reader.view(f.id, true); const before = view.runs[0]!;
    assert.equal(before.worlds.length, 2); assert.equal(before.stats?.kills, 4);
    assert.ok(!JSON.stringify(view).includes('private')); assert.equal(f.reader.frame(before.worlds[0]!.frame!)?.toString(), 'first frame0');
    await f.write(f.run('baseline') + '/session.json', f.saved('updated frame'));
    view = await f.reader.view(f.id, true); assert.notEqual(view.runs[0]!.worlds[0]!.frame, before.worlds[0]!.frame);
    await f.write(f.run('baseline') + '/result.json', { status: 'complete', ending: 'budget', metrics: { score: 123 } });
    view = await f.reader.view(f.id, true);
    assert.equal(view.finished, 1); assert.equal(view.runs[0]!.status, 'complete'); assert.equal(view.runs[0]!.ending, 'budget');
    assert.equal(view.runs[0]!.metrics?.score, 123);
  } finally { await f.cleanup(); }
});

test('terminal jobs never pretend abandoned runs are live; failed results and missing runs stay distinct', async () => {
  const f = await fixture();
  try {
    await f.write(f.run('baseline') + '/session.json', f.saved());
    await f.write(f.run('candidate') + '/result.json', { status: 'timeout', error: 'deadline reached' });
    const view = await f.reader.view(f.id, false);
    assert.equal(view.active, false); assert.equal(view.finished, 1);
    assert.deepEqual(view.runs.map(run => run.status), ['interrupted', 'timeout', 'not-run', 'not-run']);
    assert.equal(view.runs[1]!.error, 'deadline reached');
    const restarted = new LearningEvaluationReader(f.directory);
    const recovered = await restarted.view(f.id, false); assert.deepEqual(recovered, view);
    assert.equal(restarted.frame(recovered.runs[0]!.worlds[0]!.frame!)?.toString(), 'first frame0');
    await assert.rejects(f.reader.view('../manifest.json', true)); assert.equal(f.reader.frame('../secret'), undefined);
    assert.deepEqual((await f.reader.view(randomUUID(), false)).runs, []);
  } finally { await f.cleanup(); }
});


test('spectator shows the actual generated candidate menu ranked by Jev without exposing private context', async () => {
  const f = await fixture();
  try {
    const saved = { ...f.saved(), view: { ...f.saved().view, decision: {
      preparation: { planIds: ['new-route'] }, evidence: { private: 'instructions' },
      preferences: [{ action: 'probe a measured opening', probability: .8, tested: true }],
    } } };
    await f.write(f.run('candidate') + '/session.json', saved);
    const view = await f.reader.view(f.id, true);
    assert.deepEqual(view.runs[1]!.options, { generated: true, entries: [{ label: 'probe a measured opening', probability: .8, tested: true }] });
    assert.ok(!JSON.stringify(view).includes('instructions'));
  } finally { await f.cleanup(); }
});


test('saved-position previews show new test gameplay time instead of counting the inherited run', async () => {
  const f = await fixture();
  try {
    await f.write('manifest.json', { version: 2, contract: { id: 'test', scenarios: [
      { id: 'saved-stuck-position', input: { continuation: { stats: { ticks: 315 } } } },
    ] } });
    await f.write(f.run('baseline', 'saved-stuck-position') + '/session.json', f.saved());
    const view = await f.reader.view(f.id, true);
    assert.equal(view.runs[0]!.stats!.seconds, 3);
    assert.equal(view.runs[0]!.stats!.kills, 4, 'route totals still include the inherited state');
    assert.equal(view.runs[0]!.scenarioId, 'saved-stuck-position');
  } finally { await f.cleanup(); }
});

test('finished evaluation replay survives reader restart, crosses a selected fork, and never writes to storage', async () => {
  const f = await fixture();
  try {
    const directory = join(f.directory, f.id, f.run('baseline'));
    const writer = await openDoomEvaluationRecording(directory);
    const root = { id: 'root', label: 'starting plan', role: 'main', state: { tick: 0, health: 99, kills: 2 }, private: 'hidden evidence' } as unknown as WorldView;
    for (let tick = 0; tick <= 35; tick++) {
      root.state.tick = tick;
      await writer.record(root, Buffer.from(`root-${tick}`));
    }
    await writer.retainPath(root.id);
    assert.equal((await f.reader.view(f.id, true)).runs[0]!.replay, undefined);
    const runId = f.run('baseline').slice(5);
    await assert.rejects(f.reader.replayFrames(f.id, runId, 0, 1));
    const child = { ...root, id: 'winner', parentId: root.id, label: 'winning plan' };
    for (let tick = 35; tick <= 80; tick++) {
      child.state.tick = tick;
      await writer.record(child, Buffer.from(`winner-${tick}`));
    }
    await writer.retainPath(child.id);
    await writer.close({ worlds: [child], mainId: child.id } as SessionView);
    const contents = async () => {
      const paths = (await readdir(f.directory, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
      return Promise.all(paths.map(async path => [path, await readFile(path, 'base64')]));
    };
    const before = await contents();
    const reader = new LearningEvaluationReader(f.directory);
    const view = await reader.view(f.id, false);
    assert.deepEqual(view.runs[0]!.replay, { frames: 81, firstTick: 0, lastTick: 80, incomplete: false, error: undefined });
    const frames = await reader.replayFrames(f.id, runId, 30, 35);
    assert.deepEqual(frames.map(frame => frame.tick), Array.from({ length: 35 }, (_, index) => index + 30));
    assert.deepEqual(frames.map(frame => Buffer.from(frame.frame, 'base64').toString()),
      frames.map(frame => `${frame.tick <= 35 ? 'root' : 'winner'}-${frame.tick}`));
    assert.ok(frames.every(frame => frame.health === 99 && frame.kills === 2));
    assert.ok(!JSON.stringify(frames).includes('hidden evidence'));
    assert.equal((await reader.replayFrames(f.id, runId, 70, 35)).length, 11);
    for (const [start, count] of [[-1, 1], [81, 1], [0, 0], [0, 36], [.5, 1], [0, Infinity]]) {
      await assert.rejects(reader.replayFrames(f.id, runId, start!, count!), /Invalid evaluation replay range/);
    }
    await assert.rejects(reader.replayFrames(f.id, '../manifest.json', 0, 1), /unavailable/);
    await assert.rejects(reader.replayFrames(randomUUID(), runId, 0, 1), /unavailable/);
    assert.deepEqual(await contents(), before, 'spectators never mutate recording or evaluation files');
    await rm(join(directory, 'recording.json'));
    await assert.rejects(reader.replayFrames(f.id, runId, 0, 1), /unavailable/, 'a cached replay cannot bypass removed publication');
  } finally { await f.cleanup(); }
});
