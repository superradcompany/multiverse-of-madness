import { createServer } from 'node:http';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessJevModel } from './jev.ts';
import { ChessSession } from './session.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { openChessLearningHost, type ChessLearningHost } from './learning-host.ts';
import { ChessWebController } from './web-controller.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

const port = z.coerce.number().int().min(1).max(65535).parse(process.env.CHESS_PORT ?? 4321);
const directory = resolve(process.env.CHESS_DATA_DIR ?? '.data/chess-live');
const root = resolve('dist/web');
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const command = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['play', 'pause', 'step']) }),
  z.strictObject({ type: z.literal('learning'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('guide'), text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('rollback'), id: z.string().min(1).max(100) }),
  z.strictObject({ type: z.literal('new-game'), expectedMainId: z.string().min(1).max(100) }),
]);
let controller: ChessWebController | undefined;
let learningHost: ChessLearningHost | undefined;
const server = createServer(async (req, res) => {
  const json = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (!allowedHosts.has(req.headers.host ?? '') || (req.headers.origin && ![...allowedHosts].some(host => req.headers.origin === `http://${host}`))) { json(403, { error: 'Origin rejected' }); return; }
  if (!controller) { json(503, { error: 'Chess session is starting' }); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/chess') { json(200, controller.view()); return; }
    if (req.method === 'GET' && url.pathname === '/api/chess/learning-comparison') {
      const comparison = controller.learning?.comparison();
      if (!comparison) { json(404, { error: 'No recorded learning comparison yet' }); return; }
      json(200, comparison); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/chess/replay') {
      const endpoint = z.string().min(1).max(100).optional().parse(url.searchParams.get('endpoint') ?? undefined);
      json(200, await controller.session.replay(endpoint)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/chess/frame') {
      const index = z.coerce.number().int().min(0).parse(url.searchParams.get('index'));
      const endpoint = z.string().min(1).max(100).optional().parse(url.searchParams.get('endpoint') ?? undefined);
      const frame = await controller.session.replayFrame(index, endpoint);
      json(200, { state: frame.world.state, worldId: frame.world.id }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chess') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 8192) throw new Error('Request too large'); }
      const input = command.parse(JSON.parse(body));
      if (input.type === 'pause') await controller.pause();
      else if (input.type === 'play') controller.play();
      else if (input.type === 'step') await controller.step();
      else if (input.type === 'new-game') await controller.newGame(input.expectedMainId);
      else if (input.type === 'learning') {
        if (!learningHost) throw new Error('This session does not have background learning');
        await learningHost.setEnabled(input.enabled);
      }
      else if (input.type === 'guide') await controller.guide(input.text);
      else if (input.type === 'rollback') {
        if (!controller.view().checkpoints.some(point => point.id === input.id)) throw new Error('Checkpoint does not exist');
        await controller.rollback(input.id);
      }
      json(200, controller.view()); return;
    }
    if (req.method !== 'GET') { json(404, { error: 'Not found' }); return; }
    const path = url.pathname === '/' || url.pathname === '/chess.html' ? 'chess.html' : url.pathname.slice(1);
    if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(path) && path !== 'chess.html') { json(404, { error: 'Not found' }); return; }
    const data = await readFile(join(root, path));
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(data);
  } catch (error) { json(400, { error: error instanceof Error ? error.message : 'Chess request failed' }); }
});
// Claim the port before opening any persistent session; share the CLI's single-writer lock.
await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
await mkdir(directory, { recursive: true });
const lockPath = join(directory, '.owner');
const lock = await open(lockPath, 'wx', 0o600).catch(error => { server.close(); throw error; });
const lockIdentity = (await lock.stat()).ino;
async function release() {
  await lock.close();
  try { if ((await stat(lockPath)).ino === lockIdentity) await unlink(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
  let saved: ChessSessionCheckpoint | undefined;
  try { saved = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const kind = z.enum(['jev', 'fixture']).parse(process.env.CHESS_MODEL ?? (saved?.provenance.model.id === 'chess-workflow-fixture' ? 'fixture' : 'jev'));
  const model = kind === 'jev' ? await ChessJevModel.open(join(directory, 'jev')) : new ChessFixtureModel();
  const provider = new ChessRuntimeStore(join(directory, 'runtime')), adapter = new ChessAdapter();
  const learningEnabled = process.env.CHESS_LEARNING === '1' || Boolean(saved?.learning);
  if (learningEnabled && saved && !saved.learning) throw new Error('Existing plain-Jev session is preserved. Use a new CHESS_DATA_DIR for learning until session migration is available.');
  if (learningEnabled) {
    if (!(model instanceof ChessJevModel)) throw new Error('Background learning requires Jev');
    learningHost = await openChessLearningHost(directory, model, provider);
  }
  const session = saved ? await ChessSession.restore(directory, provider, adapter, model, learningHost?.binding) : await ChessSession.create(directory, provider, adapter, model, {}, learningHost?.binding);
  controller = new ChessWebController(session, 1000, learningHost);
  await learningHost?.attach(session, () => !controller!.view().busy && !controller!.view().error && !session.snapshot().batch, work => controller!.learningBoundary(work));
  console.log(`Chess ready at http://localhost:${port} (${kind}; paused)`);
} catch (error) { server.close(); await learningHost?.close(); await release(); throw error; }
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const stopped = new Promise<void>(done => server.close(() => done()));
  await controller!.pause(); await learningHost?.close(); await controller!.close(); await stopped; await release();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
