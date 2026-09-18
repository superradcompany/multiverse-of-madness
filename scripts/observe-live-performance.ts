/** Read-only delivery measurements against an already running demo; creates no VMs or model calls. */
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import type { SessionView } from '../examples/doom/contracts/src/session.ts';
import { applySessionUpdate, type SessionPatch, type SessionUpdate } from '../examples/doom/contracts/src/session-stream.ts';

const origin = new URL(process.argv[2] ?? 'http://localhost:4320');
const seconds = Number(process.argv[3] ?? 60);
const output = process.argv[4] ?? '/tmp/mom-live-performance.json';
const protocol = process.argv[5] ?? 'mom-session-patches';
if (!['mom-session-patches', 'mom-session-updates'].includes(protocol)) throw new Error('Unknown session stream protocol');
if (!['http:', 'https:'].includes(origin.protocol) || !Number.isFinite(seconds) || seconds < 5 || seconds > 3600)
  throw new Error('Usage: observe-live-performance.ts [http://host:port] [seconds: 5..3600] [report.json]');
const started = performance.now();
const stages = new Map<string, number>();
const gaps = new Map<string, number[]>();
const frames = new Map<string, { version: number; at: number; thinking: boolean; stage: string; paused: boolean; transition: boolean }>();
const errors: string[] = [];
const requests: number[] = [];
const frameRequests: number[] = [];
const decisions: Array<NonNullable<SessionView['decision']>> = [];
const seenDecisions = new Set<string>();
const learning: Array<{ atSeconds: number; enabled: unknown; busy: unknown; jobs: unknown }> = [];
let view: SessionView | undefined;
let initial: SessionView | undefined;
let previousAt = started;
let updates = 0;
let bytes = 0;
let lastMainId: string | undefined;
let mainWorldChanges = 0;
let polling = false;
let stopped = false;

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
  return { samples: sorted.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null };
}
function account(now: number) {
  const stage = view ? `${view.running ? 'running' : 'paused'}:${view.stage}` : 'connecting';
  stages.set(stage, (stages.get(stage) ?? 0) + now - previousAt);
  previousAt = now;
}
function summarize(session: SessionView | undefined) {
  const main = session?.worlds.find(world => world.id === session.mainId);
  return session && { stage: session.stage, running: session.running, error: session.error,
    main: main && { id: main.id, tick: main.state.tick, map: main.state.map, episode: main.state.episode, health: main.state.health, keys: main.state.keys },
    stats: session.stats };
}
const address = new URL('/api/events', origin);
address.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(address, protocol, { origin: origin.origin });
socket.on('error', error => errors.push(error.message));
socket.on('message', data => {
  try {
    const now = performance.now();
    account(now);
    const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytes += payload.byteLength;
    const message: SessionView | SessionUpdate | SessionPatch = JSON.parse(payload.toString());
    if ('type' in message) {
      if (!view) throw new Error('Received incremental message before initial view');
      view = applySessionUpdate(view, message);
    } else view = message;
    initial ??= structuredClone(view);
    updates++;
    if (lastMainId && lastMainId !== view.mainId) mainWorldChanges++;
    lastMainId = view.mainId;
    const activeIds = new Set<string>();
    for (const world of view.worlds.filter(world => world.role !== 'archived')) {
      activeIds.add(world.id);
      const before = frames.get(world.id);
      if (before) {
        before.paused ||= !view.running;
        before.transition ||= before.stage !== view.stage;
        before.thinking ||= !!world.thinking;
      }
      if (before && before.version !== world.frameVersion) {
        const key = before.paused ? 'includes-pause' : before.thinking ? 'includes-decision-wait' : before.transition ? 'phase-transition' : view.stage;
        const values = gaps.get(key) ?? [];
        values.push(now - before.at); gaps.set(key, values);
      }
      if (!before || before.version !== world.frameVersion)
        frames.set(world.id, { version: world.frameVersion, at: now, thinking: !!world.thinking, stage: view.stage, paused: !view.running, transition: false });
    }
    for (const id of frames.keys()) if (!activeIds.has(id)) frames.delete(id);
    const decision = view.decision;
    if (decision) {
      const key = `${decision.sourceId}:${decision.tick}:${decision.learning?.activation.epoch}`;
      if (!seenDecisions.has(key)) { seenDecisions.add(key); if (updates > 1) decisions.push(decision); }
    }
  } catch (error) { errors.push(String(error)); }
});
socket.on('close', (code, reason) => { if (!stopped) errors.push(`Stream closed early: ${code} ${reason}`); });
async function poll() {
  if (polling || stopped) return;
  polling = true;
  try {
    const before = performance.now();
    const response = await fetch(new URL('/api/learning', origin), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Learning HTTP ${response.status}`);
    const result = await response.json();
    requests.push(performance.now() - before);
    learning.push({ atSeconds: (performance.now() - started) / 1000, enabled: result.enabled, busy: result.busy,
      jobs: result.jobs?.filter((job: { status: string }) => job.status === 'running').map((job: { id: string; kind: string }) => ({ id: job.id, kind: job.kind })) });
    const world = view?.worlds.find(world => world.role === 'experiment') ?? view?.worlds.find(world => world.id === view?.mainId);
    if (world) {
      const frameStart = performance.now();
      const frame = await fetch(new URL(`/api/frame/${encodeURIComponent(world.id)}?v=${world.frameVersion}`, origin), { signal: AbortSignal.timeout(5000) });
      if (!frame.ok) throw new Error(`Frame HTTP ${frame.status}`);
      await frame.arrayBuffer();
      frameRequests.push(performance.now() - frameStart);
    }
  } catch (error) { errors.push(String(error)); }
  finally { polling = false; }
}
const timer = setInterval(() => { void poll(); }, 5000);
await poll();
await new Promise(resolve => setTimeout(resolve, seconds * 1000));
stopped = true;
clearInterval(timer);
account(performance.now());
socket.close();
while (polling) await new Promise(resolve => setTimeout(resolve, 50));
const durationSeconds = (previousAt - started) / 1000;
const report = { format: 2, protocol, startedAt: new Date(Date.now() - durationSeconds * 1000).toISOString(), durationSeconds,
  limitations: ['Measures delivered frame-version changes, not browser paint FPS or isolated simulation speed.',
    'Gap categories describe observed state and can include lifecycle waits; they do not establish causation.',
    'Decision metadata covers the session-level latest decision, not every parallel-world Jev request.',
    'Main-world changes include rollback and manual selection, not only winning promotions.',
    'Read-only observer adds one stream and a learning/frame HTTP probe every five seconds.'],
  initial: summarize(initial), final: summarize(view), updates, deliveredBytes: bytes, kibibytesPerSecond: bytes / 1024 / durationSeconds, mainWorldChanges,
  stageSeconds: Object.fromEntries([...stages].map(([key, value]) => [key, value / 1000])),
  frameVersionGaps: Object.fromEntries([...gaps].map(([key, values]) => [key, distribution(values)])),
  learningHttp: distribution(requests), frameHttp: distribution(frameRequests),
  decisions: { count: decisions.length, prefetched: decisions.filter(decision => decision.prefetched).length,
    wait: distribution(decisions.flatMap(decision => decision.waitMs === undefined ? [] : [decision.waitMs])),
    request: distribution(decisions.flatMap(decision => decision.latencyMs === undefined ? [] : [decision.latencyMs])) },
  learning, errors };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, durationSeconds, updates, mainWorldChanges, errors }));
if (errors.length || !updates) process.exitCode = 1;
