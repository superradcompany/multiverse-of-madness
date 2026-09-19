import { VmSettingsStore } from './vm-settings.ts';
import { sessionControl } from '../../../shared/server/session-control.ts';
import { SessionStream } from './session-stream.ts';
import { RecordingReader } from './recording-reader.ts';
import { BufferedRecorder } from './buffered-recorder.ts';
import { acquireDataLease } from './data-lease.ts';
import { collectDoomUpgradeWork, doomUpgradeReferences } from './doom-upgrade-work.ts';
import { doomProposalKindSchema } from './doom-supervisor-proposal.ts';
import { DoomLearningService } from './doom-learning-service.ts';
import { readDoomLearningBuild } from './doom-learning-build.ts';
import { vmResourceStateSchema, vmSettingsSchema } from '../../contracts/src/vm.ts';
import { MovieExports } from './movie-export.ts';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { skillInput } from './ai-skills.ts';
import '../../../../scripts/runtime-env.ts';
import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { inputSchema } from '../../contracts/src/game.ts';
import { checkpoints } from './checkpoints.ts';
import { Session } from './session.ts';
import { navigateDoomInputs } from './doom-navigation.ts';
import { geometryFor } from './doom-geometry.ts';
import { Jev } from './jev.ts';
import { createWorld, reconnectWorld, recoverPendingWorld, destroyWorld } from './runtime.ts';
import { SessionStore } from './persistence.ts';
import { Recordings } from './recordings.ts';

const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 4317);
const dataDirectory = z.string().min(1).optional().parse(process.env.MOM_DATA_DIR);
const managed = sessionControl(port);
// Bind first: older servers did not take a data lease, but already own their HTTP port.
// No session, recording, VM or learning journal is opened before both ownership checks succeed.
let handler: RequestListener | undefined;
const server = createServer((req, res) => {
  if (managed.handle(req, res)) return;
  if (handler) { handler(req, res); return; }
  res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1' });
  res.end(JSON.stringify({ error: 'Session is starting' }));
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const dataLease = await acquireDataLease(resolve(dataDirectory ?? '.data')).catch(async error => {
  await new Promise<void>(resolve => server.close(() => resolve())); throw error;
});
const dataPath = (...parts: string[]) => resolve(dataLease.directory, ...parts);
const store = new SessionStore(dataPath('session.json'));
const profile = z.enum(['game-aware', 'baseline']).parse(process.env.JEV_PROFILE ?? 'game-aware');
const saved = await store.load();
await collectDoomUpgradeWork(dataPath('learning'), await doomUpgradeReferences(dataLease.directory))
  .catch(error => console.error('Abandoned upgrade cleanup deferred:', error.message));
const learning = await DoomLearningService.open({ directory: dataPath('learning'), profile, build: await readDoomLearningBuild() }, saved?.learning?.binding);
const session = new Session(new Jev(profile), undefined, saved?.learning ? learning.binding : undefined);
const vmSettings = new VmSettingsStore(dataPath('vm-settings.json'));
await vmSettings.open();
session.setVmSettings(vmSettings);
session.setCheckpointAdapter(checkpoints);
if (profile === 'game-aware') session.setControls(async (state, inputs, navigation, policy) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation, policy));
const retention = z.object({
  megabytes: z.coerce.number().int().min(1).default(1024),
  hours: z.coerce.number().positive().default(24),
  worlds: z.coerce.number().int().min(1).default(200),
}).parse({ megabytes: process.env.RECORDING_MAX_MB, hours: process.env.RECORDING_MAX_HOURS, worlds: process.env.RECORDING_MAX_WORLDS });
const recordings = new Recordings(dataPath('recordings'), retention.megabytes * 1024 ** 2,
  { maxAgeMs: retention.hours * 3600000, maxWorlds: retention.worlds });
await recordings.open();
const recordingReader = new RecordingReader(dataPath('recordings'), recordings);
const movies = new MovieExports(recordings, dataDirectory !== undefined ? dataPath('movie-exports') : resolve('.cache/movie-exports'));
await movies.open();
const recordingBuffer = new BufferedRecorder((world, frame) => recordings.record(world, frame));
session.setRecorder((world, frame) => recordingBuffer.record(world, frame));
session.setMainRecorder(id => recordings.retainPath(id));
if (saved) await session.restore(saved, reconnectWorld, recoverPendingWorld, destroyWorld);
else await session.initialize(await createWorld(`mom-${Date.now().toString(36)}`, vmSettings.settings.defaults));
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
await learning.attach(session);
const learningCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('enable') }),
  z.strictObject({ type: z.literal('automation'), enabled: z.boolean(), provider: z.enum(['codex', 'claude']) }),
  z.strictObject({ type: z.literal('propose'), id: z.string().uuid(), proposalKind: doomProposalKindSchema.optional(), provider: z.enum(['codex', 'claude']).optional() }),
  z.strictObject({ type: z.literal('evaluate'), id: z.string().uuid(), proposalId: z.string().uuid() }),
  z.strictObject({ type: z.literal('activate'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('cancel'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('rollback'), target: z.strictObject({ id: z.string().min(1).max(128), version: z.string().min(1).max(256) }) }),
]);
const commandSchema = z.discriminatedUnion('type', [
  skillInput.extend({ type: z.literal('skill-save'), id: z.string().uuid().optional() }),
  z.object({ type: z.literal('skill-toggle'), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({ type: z.literal('skill-delete'), id: z.string().uuid() }),
  z.object({ type: z.literal('max-futures'), count: z.number().int().min(2).max(10) }),
  z.object({ type: z.literal('fork-threshold'), threshold: z.number().min(0).max(1) }),
  z.object({ type: z.literal('memory-settings'), capacity: z.number().int().min(8).max(1024), perDecision: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal('planning-mode'), mode: z.enum(['plans', 'actions']) }),
  z.object({ type: z.literal('checkpoint-save') }),
  z.object({ type: z.enum(['rollback', 'checkpoint-delete']), checkpointId: z.string().uuid() }),
  z.object({ type: z.literal('recovery-policy'), enabled: z.boolean(), maxRetries: z.number().int().min(0).max(10), healthLoss: z.number().int().min(1).max(100), stallSeconds: z.number().int().min(5).max(120) }),
  z.object({ type: z.literal('trial-duration'), ticks: z.number().int().min(35).max(2100) }),
  z.object({ type: z.literal('decision-interval'), ticks: z.number().int().min(7).max(2100) }),
  z.object({ type: z.literal('decision-interval-mode'), mode: z.enum(['fixed', 'trial']) }),
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
handler = async (req, res) => {
  const respond = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.headers.origin && !origins.has(req.headers.origin)) { respond(403, { error: 'Origin rejected' }); return; }
  if (!new Set([`localhost:${port}`, `127.0.0.1:${port}`]).has(req.headers.host ?? '')) { respond(403, { error: 'Host rejected' }); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    const evaluationPreview = /^\/api\/learning\/evaluations\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && evaluationPreview) { respond(200, await learning.evaluationView(evaluationPreview[1]!)); return; }
    const evaluationReplay = /^\/api\/learning\/evaluations\/([a-f0-9-]{36})\/replays\/([a-f0-9]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && evaluationReplay) {
      respond(200, await learning.evaluationReplayFrames(evaluationReplay[1]!, evaluationReplay[2]!,
        Number(url.searchParams.get('start') ?? 0), Number(url.searchParams.get('count') ?? 35))); return;
    }
    const evaluationFrame = /^\/api\/learning\/evaluation-frames\/([a-f0-9]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && evaluationFrame) {
      const frame = learning.evaluationFrame(evaluationFrame[1]!);
      if (!frame) { respond(404, { error: 'Preview expired; refresh evaluation progress' }); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' }); res.end(frame); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/learning/status') { respond(200, learning.backgroundView()); return; }
    if (req.method === 'GET' && url.pathname === '/api/learning') { respond(200, learning.view()); return; }
    const learningDetail = /^\/api\/learning\/proposals\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && learningDetail) { respond(200, await learning.detail(learningDetail[1]!)); return; }
    if (req.method === 'POST' && url.pathname === '/api/learning') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body = ''; for await (const part of req) { body += part; if (body.length > 4096) throw new Error('Request too large'); }
      const input = learningCommand.parse(JSON.parse(body));
      if (input.type === 'automation') await learning.setAutomation(input.enabled, input.provider);
      else if (input.type === 'propose') await learning.start({ kind: 'propose', id: input.id, ...(input.provider ? { provider: input.provider } : {}), ...(input.proposalKind ? { proposalKind: input.proposalKind } : {}) });
      else if (input.type === 'evaluate') await learning.start({ kind: 'evaluate', id: input.id, proposalId: input.proposalId });
      else if (input.type === 'cancel') await learning.cancel(input.id);
      else {
        const task = commands.then(async () => {
          if (input.type === 'enable') await learning.enable();
          else if (input.type === 'activate') await learning.activate(input.id);
          else await learning.rollback(input.target);
          await store.save(session.checkpoint());
        });
        commands = task.catch(() => {}); await task;
      }
      respond(input.type === 'propose' || input.type === 'evaluate' ? 202 : 200, learning.view()); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/vms') { respond(200, await session.vmOverview()); return; }
    if (req.method === 'POST' && (url.pathname === '/api/vms/settings' || url.pathname === '/api/vms/modify')) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body = '';
      for await (const part of req) { body += part; if (body.length > 4096) throw new Error('Request too large'); }
      const input = JSON.parse(body);
      let result: unknown;
      const task = commands.then(async () => {
        if (url.pathname === '/api/vms/settings') { await vmSettings.update(vmSettingsSchema.parse(input)); result = await session.vmOverview(); }
        else {
          const patch = z.object({ worldId: z.string().min(1).max(256), resources: vmResourceStateSchema, dryRun: z.boolean() }).strict().parse(input);
          result = await session.modifyVm(patch.worldId, patch.resources, patch.dryRun);
        }
      });
      commands = task.catch(() => {}); await task; respond(200, result); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/movie-exports') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body = '';
      for await (const part of req) { body += part; if (body.length > 4096) throw new Error('Request too large'); }
      const input = z.object({ worldId: z.string().min(1).max(256), untilTick: z.number().int().nonnegative(), single: z.boolean().default(false), allowPartial: z.boolean().default(false) }).parse(JSON.parse(body));
      respond(202, await movies.start(input.worldId, input.untilTick, input.single, input.allowPartial)); return;
    }
    const movie = /^\/api\/movie-exports\/([a-f0-9-]{36})(\/file)?$/.exec(url.pathname);
    if (movie) {
      const id = movie[1]!;
      if (req.method === 'GET' && movie[2]) {
        const file = movies.file(id), info = movies.get(id);
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': info.bytes!, 'content-disposition': `attachment; filename="multiverse-${id.slice(0, 8)}.mp4"`, 'cache-control': 'no-store' });
        await pipeline(createReadStream(file), res); return;
      }
      if (req.method === 'GET') { respond(200, movies.get(id)); return; }
      if (req.method === 'DELETE' && !movie[2]) { await movies.cancel(id); respond(200, movies.get(id)); return; }
    }
    if (req.method === 'GET' && url.pathname === '/api/replay-path') {
      const id = url.searchParams.get('worldId') ?? session.snapshot().mainId;
      const cutoff = url.searchParams.get('untilTick');
      respond(200, await recordings.path(id, cutoff === null ? undefined : Number(cutoff), url.searchParams.get('single') === 'true')); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/recordings') { respond(200, recordings.list()); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/api/recordings/')) {
      const parts = url.pathname.slice('/api/recordings/'.length).split('/');
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) throw new Error('Invalid recording request');
      respond(200, await recordingReader.get(decodeURIComponent(parts[0]!), Number(parts[1]))); return;
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
        if (['resume', 'step', 'restart'].includes(command.type)) await session.reconcileFork(recoverPendingWorld);
        switch (command.type) {
          case 'checkpoint-save': await session.saveRecoveryCheckpoint(); break;
          case 'rollback': await session.rollback(command.checkpointId); break;
          case 'checkpoint-delete': await session.deleteCheckpoint(command.checkpointId); break;
          case 'recovery-policy': { const { type, ...policy } = command; session.setRecoveryPolicy(policy); break; }
          case 'max-futures': session.setMaxFutures(command.count); break;
          case 'fork-threshold': session.setForkThreshold(command.threshold); break;
          case 'skill-save': session.saveSkill(command, command.id); break;
          case 'skill-toggle': session.toggleSkill(command.id, command.enabled); break;
          case 'skill-delete': session.deleteSkill(command.id); break;
          case 'memory-settings': session.configureMemory(command.capacity, command.perDecision); break;
          case 'planning-mode': session.setPlanningMode(command.mode); break;
          case 'trial-duration': session.setTrialDuration(command.ticks); break;
          case 'decision-interval': session.setDecisionInterval(command.ticks); break;
          case 'decision-interval-mode': session.setDecisionIntervalMode(command.mode); break;
          case 'winner-delay': session.setWinnerDelay(command.seconds); break;
          case 'restart': await session.restart(() => createWorld(`mom-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`, vmSettings.settings.defaults), id => recordings.clearExcept(id)); break;
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
  } catch (error) { if (res.headersSent || res.destroyed) { res.destroy(); return; } respond(400, { error: error instanceof Error ? error.message : 'Request failed' }); }
};
const sockets = new WebSocketServer({ noServer: true });
const streams = new WeakMap<WebSocket, SessionStream>();
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/events' || !origins.has(req.headers.origin ?? '')) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, client => {
    const view = session.snapshot();
    client.send(JSON.stringify(view));
    if (client.protocol === 'mom-session-updates') streams.set(client, new SessionStream(view));
    if (client.protocol === 'mom-session-patches') streams.set(client, new SessionStream(view, 'patches'));
    sockets.emit('connection', client, req);
  });
});
let persistenceFailed = false;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
session.on('change', (view: ReturnType<Session['snapshot']>) => {
  // The event already contains an isolated snapshot. Avoid cloning every world
  // again for each frame from each concurrently running future.
  recordings.protect(view.worlds.filter(w => w.role !== 'archived').map(w => w.id));
  // Coalesce parallel world updates. Lifecycle journals still persist synchronously
  // through Session.setPersistence; frame-only progress can be refreshed from VMs.
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    const view = session.snapshot();
    let body: string | undefined;
    for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1_000_000) {
      const stream = streams.get(socket);
      socket.send(stream ? JSON.stringify(stream.update(view)) : body ??= JSON.stringify(view));
    }
  }, 25);
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    void store.save(session.checkpoint()).catch(error => {
      if (!persistenceFailed) { persistenceFailed = true; console.error('Session persistence failed:', error.message); void session.pause().catch(() => {}); }
    });
  }, 1000);
});
console.log(`multiverse of madness: http://localhost:${port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  handler = undefined;
  await commands; await session.pause(); await learning.close(); await movies.close(); clearInterval(recordingTimer); clearInterval(collectionTimer); await recordings.flush(); clearTimeout(saveTimer); clearTimeout(broadcastTimer); await store.save(session.checkpoint()); await store.flush();
  for (const socket of sockets.clients) socket.terminate();
  server.close(() => { void dataLease.release().then(() => process.exit(0)); });
  server.closeAllConnections();
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
managed.ready(shutdown);
