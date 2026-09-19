import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireChessDataLease } from './data-lease.ts';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessJevModel } from './jev.ts';
import { ChessSession } from './session.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  directory: { type: 'string', default: '.data/chess-demo' }, cycles: { type: 'string', default: '8' },
  guide: { type: 'string' }, model: { type: 'string' }, 'jev-model': { type: 'string' }, 'max-model-calls': { type: 'string' },
  fen: { type: 'string' }, threshold: { type: 'string' }, breadth: { type: 'string' }, 'trial-plies': { type: 'string' }, checkpoint: { type: 'string' }, frame: { type: 'string' },
} });
const command = positionals[0] ?? 'run', root = resolve(values.directory!);
const cycles = Number(values.cycles);
if (positionals.length > 1 || !['run', 'status', 'rollback', 'replay'].includes(command) || !Number.isSafeInteger(cycles) || cycles < 0 || cycles > 10000) throw new Error('Expected run/status/rollback/replay and 0 to 10000 cycles');
const lease = await acquireChessDataLease(root);
let session: ChessSession | undefined;
try {
  let saved: ChessSessionCheckpoint | undefined;
  try { saved = JSON.parse(await readFile(join(root, 'session.json'), 'utf8')) as ChessSessionCheckpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved && [values.fen, values.threshold, values.breadth, values['trial-plies']].some(value => value !== undefined)) throw new Error('Existing session configuration is pinned; use a new directory for a different profile');
  const provider = new ChessRuntimeStore(join(root, 'runtime'), values.fen), adapter = new ChessAdapter();
  const modelKind = values.model ?? (saved?.provenance.model.id === 'chess-jev' ? 'jev' : 'fixture');
  if (!['fixture', 'jev'].includes(modelKind)) throw new Error('Model must be fixture or jev');
  if (modelKind !== 'jev' && (values['jev-model'] !== undefined || values['max-model-calls'] !== undefined)) throw new Error('Jev options require --model jev');
  const model = modelKind === 'jev' ? await ChessJevModel.open(join(root, 'jev'), {
    ...(values['jev-model'] === undefined ? {} : { model: values['jev-model'] }),
    ...(values['max-model-calls'] === undefined ? {} : { maxCalls: Number(values['max-model-calls']) }),
  }) : new ChessFixtureModel();
  if (saved) session = await ChessSession.restore(root, provider, adapter, model);
  else if (command === 'run') session = await ChessSession.create(root, provider, adapter, model, {
    ...(values.threshold === undefined ? {} : { threshold: Number(values.threshold) }), ...(values.breadth === undefined ? {} : { breadth: Number(values.breadth) }),
    ...(values['trial-plies'] === undefined ? {} : { trialPlies: Number(values['trial-plies']) }),
  });
  else throw new Error('No saved session; use run to create one');
  if (values.guide !== undefined) {
    if (command !== 'run') throw new Error('--guide requires run (use --cycles 0 to only update guidance)');
    await session.guide(values.guide);
  }
  let interrupted = false;
  const stop = () => { interrupted = true; void session!.pause().catch(() => {}); };
  process.on('SIGINT', stop);
  try {
    if (command === 'run') for (let i = 0; i < cycles && !interrupted; i++) {
      const before = session.snapshot(), main = before.worlds.find(world => world.meta.id === before.mainId)!;
      if (main.state.status !== 'ongoing' && !before.batch) break;
      await session.step(); const snapshot = session.snapshot(), current = snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!;
      console.log(JSON.stringify({ event: snapshot.batch ? 'comparison-ready' : 'main-advanced', main: current.meta.id, moves: current.state.moves,
        futures: snapshot.batch?.ids.map(id => { const world = snapshot.worlds.find(world => world.meta.id === id)!; return { id, moves: world.state.moves, status: world.state.status }; }), attempts: snapshot.attempts }));
    }
    if (command === 'rollback') {
      const point = values.checkpoint ?? session.snapshot().points.points.at(-1)?.id;
      if (!point) throw new Error('No execution checkpoint available');
      await session.rollback(point);
    }
    if (command === 'replay' && values.frame !== undefined) {
      const frame = await session.replayFrame(Number(values.frame));
      console.log(Buffer.from(frame.frame, 'base64').toString('utf8'));
      console.log(JSON.stringify({ replayedWorld: frame.world.id, ply: frame.world.state.ply, provenance: frame.world.provenance }));
    }
    const snapshot = session.snapshot(), main = snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!;
    console.log(JSON.stringify({ directory: root, provider: modelKind === 'fixture' ? 'deterministic workflow fixture' : 'TypeSafe Jev',
      ...(model instanceof ChessJevModel ? { modelBudget: model.budget() } : {}), main: { id: main.meta.id, state: main.state, statistics: main.statistics },
      checkpoints: snapshot.points.points.map(point => ({ id: point.id, ply: point.data.state.ply })), attempts: snapshot.attempts, experienceCount: snapshot.experiences.length,
      ...(command === 'replay' ? { replay: await session.replay() } : {}) }, null, 2));
  } finally { process.removeListener('SIGINT', stop); await session.detach(); }
} finally {
  await lease.release();
}
