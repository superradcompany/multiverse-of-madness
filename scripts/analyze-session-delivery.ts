/** Repeated-view CPU benchmark only; no server, runtime, model or saved-state writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { SessionStream } from '../examples/doom/server/src/session-stream.ts';
import { applySessionUpdate } from '../examples/doom/contracts/src/session-stream.ts';
import type { SessionView } from '../examples/doom/contracts/src/session.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { samples: { type: 'string', default: '500' } } });
if (positionals.length !== 1) throw new Error('Usage: node --import tsx scripts/analyze-session-delivery.ts [--samples 500] session.json');
const samples = z.coerce.number().int().min(10).max(10000).parse(values.samples);
const bytes = await readFile(positionals[0]!);
const input: unknown = JSON.parse(bytes.toString());
// Check the subset used here without rewriting or stripping the saved view.
z.object({ view: z.object({ worlds: z.array(z.object({ id: z.string(), role: z.enum(['main', 'experiment', 'archived']),
  frameVersion: z.number().int().nonnegative(), state: z.object({ tick: z.number().int().nonnegative() }) })).min(1) }) }).parse(input);
const view = (input as { view: SessionView }).view;
const active = view.worlds.filter(world => world.role !== 'archived');
if (!active.length || new Set(view.worlds.map(world => world.id)).size !== view.worlds.length) throw new Error('Expected distinct worlds and at least one live-role world');
const checksum = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const summary = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)]!;
  return { median: percentile(.5), p95: percentile(.95), max: ordered.at(-1)! };
};
const results = [];
for (const clients of [1, 4]) {
  const cursors = Array.from({ length: clients }, () => new SessionStream(view, 'patches'));
  const received = Array.from({ length: clients }, () => view);
  const cloneMs: number[] = [], diffMs: number[] = [], encodeMs: number[] = [], batchMs: number[] = [], wireBytes: number[] = [];
  const advancing = structuredClone(view);
  let latest = view;
  for (let index = 0; index < samples + 100; index++) {
    // Advance a different live world on each batch, never mutate the source.
    const changed = advancing.worlds.find(world => world.id === active[index % active.length]!.id)!;
    changed.frameVersion++; changed.state.tick++;
    const began = performance.now();
    latest = structuredClone(advancing);
    const cloned = performance.now();
    const messages = cursors.map(cursor => cursor.update(latest));
    const diffed = performance.now();
    const bodies = messages.map(message => JSON.stringify(message));
    const encoded = performance.now();
    if (index >= 100) {
      cloneMs.push(cloned - began); diffMs.push(diffed - cloned); encodeMs.push(encoded - diffed); batchMs.push(encoded - began);
      wireBytes.push(bodies.reduce((total, body) => total + Buffer.byteLength(body), 0));
    }
    // Verify the actual encoded protocol outside the measured server work.
    for (const message of messages) assert.equal(message.worlds.length, 1, 'Each batch must change exactly one world');
    bodies.forEach((body, client) => { received[client] = applySessionUpdate(received[client]!, JSON.parse(body)); });
  }
  for (const reconstructed of received) assert.deepEqual(reconstructed, latest);
  results.push({ clients, samples, cloneMs: summary(cloneMs), diffMs: summary(diffMs), encodeMs: summary(encodeMs), batchMs: summary(batchMs), wireBytes: summary(wireBytes) });
}
assert.equal(checksum(await readFile(positionals[0]!)), checksum(bytes), 'Source changed during the benchmark');
process.stdout.write(JSON.stringify({ format: 1, measuredAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, platform: process.platform, arch: process.arch,
  benchmarkSha256: checksum(await readFile(new URL(import.meta.url))),
  sourceSha256: checksum(bytes), worlds: view.worlds.length, activeWorlds: active.length, viewBytes: Buffer.byteLength(JSON.stringify(view)),
  scope: 'Repeated saved-view CPU work only, with one live world tick/version advanced per batch. Diff/encode sum all clients. Excludes snapshot assembly, PNG fetch/decode, browser paint, network, persistence, VM and model latency.',
  results }, null, 2) + '\n');
