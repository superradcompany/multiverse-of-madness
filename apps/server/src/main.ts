import { skillInput } from './ai-skills.ts';
import '../../../scripts/runtime-env.ts';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { inputSchema } from '../../../packages/contracts/src/game.ts';
import { checkpoints } from './checkpoints.ts';
import { Session } from './session.ts';
import { navigateDoomInputs } from './doom-navigation.ts';
import { geometryFor } from './doom-geometry.ts';
import { Jev } from './jev.ts';
import { createWorld, reconnectWorld, recoverPendingWorld, destroyWorld } from './runtime.ts';
import { SessionStore } from './persistence.ts';
import { Recordings } from './recordings.ts';

const port = Number(process.env.PORT ?? 4317);
const store = new SessionStore(resolve('.data/session.json'));
const profile = z.enum(['game-aware', 'baseline']).parse(process.env.JEV_PROFILE ?? 'game-aware');
const session = new Session(new Jev(profile));
session.setCheckpointAdapter(checkpoints);
if (profile === 'game-aware') session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
const retention = z.object({
  megabytes: z.coerce.number().int().min(1).default(1024),
  hours: z.coerce.number().positive().default(24),
  worlds: z.coerce.number().int().min(1).default(200),
}).parse({ megabytes: process.env.RECORDING_MAX_MB, hours: process.env.RECORDING_MAX_HOURS, worlds: process.env.RECORDING_MAX_WORLDS });
const recordings = new Recordings(resolve('.data/recordings'), retention.megabytes * 1024 ** 2,
  { maxAgeMs: retention.hours * 3600000, maxWorlds: retention.worlds });
await recordings.open();
session.setRecorder((world, frame) => recordings.record(world, frame));
session.setMainRecorder(id => recordings.retainPath(id));
const saved = await store.load();
if (saved) await session.restore(saved, reconnectWorld, recoverPendingWorld, destroyWorld);
else await session.initialize(await createWorld(`mom-${Date.now().toString(36)}`));
await session.finishRecordingReset(id => recordings.clearExcept(id));
recordings.protect(session.snapshot().worlds.filter(w => w.role !== 'archived').map(w => w.id));
for (const world of session.snapshot().worlds.filter(w => w.role !== 'archived')) await recordings.record(world, session.frame(world.id));
await recordings.retainPath(session.snapshot().mainId);
await recordings.collect();
const collectionTimer = setInterval(() => {
  void recordings.collect();
  void session.collectGarbage(destroyWorld).catch(error => console.error('Sandbox cleanup retry failed:', error.message));
}, 30000);
const recordingTimer = setInterval(() => { void recordings.flush(); }, 1000);
session.setPersistence(checkpoint => store.save(checkpoint));
await store.save(session.checkpoint());
const commandSchema = z.discriminatedUnion('type', [
  skillInput.extend({ type: z.literal('skill-save'), id: z.string().uuid().optional() }),
  z.object({ type: z.literal('skill-toggle'), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({ type: z.literal('skill-delete'), id: z.string().uuid() }),
  z.object({ type: z.literal('fork-threshold'), threshold: z.number().min(0).max(1) }),
  z.object({ type: z.literal('memory-settings'), capacity: z.number().int().min(8).max(1024), perDecision: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal('planning-mode'), mode: z.enum(['plans', 'actions']) }),
  z.object({ type: z.literal('checkpoint-save') }),
  z.object({ type: z.enum(['rollback', 'checkpoint-delete']), checkpointId: z.string().uuid() }),
  z.object({ type: z.literal('recovery-policy'), enabled: z.boolean(), maxRetries: z.number().int().min(0).max(10), healthLoss: z.number().int().min(1).max(100), stallSeconds: z.number().int().min(5).max(120) }),
  z.object({ type: z.literal('trial-duration'), ticks: z.number().int().min(35).max(2100) }),
  z.object({ type: z.literal('decision-interval'), ticks: z.number().int().min(7).max(210) }),
  z.object({ type: z.literal('winner-delay'), seconds: z.number().min(0).max(60) }),
  z.object({ type: z.literal('restart'), confirm: z.literal(true) }),
  z.object({ type: z.enum(['pause', 'resume', 'step', 'clear-experience']) }),
  z.object({ type: z.literal('experience'), enabled: z.boolean() }),
  z.object({ type: z.enum(['takeover', 'release', 'promote']), worldId: z.string() }),
  z.object({ type: z.literal('direction'), text: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('input'), worldId: z.string(), inputs: z.array(inputSchema).max(8) }),
]);
let commands = Promise.resolve();
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const server = createServer(async (req, res) => {
  const respond = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.headers.origin && !origins.has(req.headers.origin)) { respond(403, { error: 'Origin rejected' }); return; }
  if (!new Set([`localhost:${port}`, `127.0.0.1:${port}`]).has(req.headers.host ?? '')) { respond(403, { error: 'Host rejected' }); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/replay-path') {
      const id = url.searchParams.get('worldId') ?? session.snapshot().mainId;
      const cutoff = url.searchParams.get('untilTick');
      respond(200, await recordings.path(id, cutoff === null ? undefined : Number(cutoff), url.searchParams.get('single') === 'true')); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/recordings') { respond(200, recordings.list()); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/api/recordings/')) {
      const parts = url.pathname.slice('/api/recordings/'.length).split('/');
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) throw new Error('Invalid recording request');
      respond(200, await recordings.get(decodeURIComponent(parts[0]!), Number(parts[1]))); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session') { respond(200, session.snapshot()); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/api/frame/')) {
      const frame = session.frame(decodeURIComponent(url.pathname.slice('/api/frame/'.length)));
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(frame); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body = '';
      for await (const part of req) { body += part; if (body.length > 8192) throw new Error('Request too large'); }
      const command = commandSchema.parse(JSON.parse(body));
      const task = commands.then(async () => {
        switch (command.type) {
          case 'checkpoint-save': await session.saveRecoveryCheckpoint(); break;
          case 'rollback': await session.rollback(command.checkpointId); break;
          case 'checkpoint-delete': await session.deleteCheckpoint(command.checkpointId); break;
          case 'recovery-policy': session.setRecoveryPolicy(command); break;
          case 'fork-threshold': session.setForkThreshold(command.threshold); break;
          case 'skill-save': session.saveSkill(command, command.id); break;
          case 'skill-toggle': session.toggleSkill(command.id, command.enabled); break;
          case 'skill-delete': session.deleteSkill(command.id); break;
          case 'memory-settings': session.configureMemory(command.capacity, command.perDecision); break;
          case 'planning-mode': session.setPlanningMode(command.mode); break;
          case 'trial-duration': session.setTrialDuration(command.ticks); break;
          case 'decision-interval': session.setDecisionInterval(command.ticks); break;
          case 'winner-delay': session.setWinnerDelay(command.seconds); break;
          case 'restart': await session.restart(() => createWorld(`mom-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`), id => recordings.clearExcept(id)); break;
          case 'experience': session.useExperience(command.enabled); break;
          case 'clear-experience': session.clearExperience(); break;
          case 'pause': await session.pause(); break;
          case 'resume': session.resume(); break;
          case 'step': session.step(); break;
          case 'takeover': await session.takeover(command.worldId); break;
          case 'release': session.release(command.worldId); break;
          case 'promote': await session.promote(command.worldId); break;
          case 'direction': session.queueObjective(command.text); break;
          case 'input': await session.input(command.worldId, command.inputs); break;
        }
        await store.save(session.checkpoint());
      });
      commands = task.catch(() => {});
      await task;
      respond(200, session.snapshot()); return;
    }
    if (req.method !== 'GET') { respond(404, { error: 'Not found' }); return; }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const root = resolve('dist/web');
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(`${root}/`)) { respond(404, { error: 'Not found' }); return; }
    const content = await readFile(file);
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(content);
  } catch (error) { respond(400, { error: error instanceof Error ? error.message : 'Request failed' }); }
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/events' || !origins.has(req.headers.origin ?? '')) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, client => { client.send(JSON.stringify(session.snapshot())); sockets.emit('connection', client, req); });
});
let persistenceFailed = false;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
session.on('change', () => {
  recordings.protect(session.snapshot().worlds.filter(w => w.role !== 'archived').map(w => w.id));
  // Coalesce parallel world updates. Lifecycle journals still persist synchronously
  // through Session.setPersistence; frame-only progress can be refreshed from VMs.
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    const body = JSON.stringify(session.snapshot());
    for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1_000_000) socket.send(body);
  }, 25);
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    void store.save(session.checkpoint()).catch(error => {
      if (!persistenceFailed) { persistenceFailed = true; console.error('Session persistence failed:', error.message); void session.pause().catch(() => {}); }
    });
  }, 250);
});
server.listen(port, '127.0.0.1', () => console.log(`multiverse of madness: http://localhost:${port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await session.pause(); clearInterval(recordingTimer); clearInterval(collectionTimer); await recordings.flush(); clearTimeout(saveTimer); clearTimeout(broadcastTimer); await store.save(session.checkpoint()); await store.flush();
  for (const socket of sockets.clients) socket.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
