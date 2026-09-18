/** Read-only catalog sampling. Unassigned worlds are not automatically classified as orphans. */
import './runtime-env.ts';
import { writeFile } from 'node:fs/promises';
import { Sandbox, Snapshot } from 'microsandbox';
import { z } from 'zod';

const origin = new URL(process.argv[2] ?? 'http://localhost:4320');
const seconds = Number(process.argv[3] ?? 120), output = process.argv[4] ?? '/tmp/mom-runtime-load.json';
if (!['http:', 'https:'].includes(origin.protocol) || !Number.isFinite(seconds) || seconds < 10 || seconds > 3600)
  throw new Error('Usage: observe-runtime-load.ts [http://host:port] [seconds: 10..3600] [report.json]');
const config = z.object({ resources: z.object({ cpus: z.number(), memory_mib: z.number() }), labels: z.record(z.string(), z.string()) });
const sessionSchema = z.object({ running: z.boolean(), stage: z.string(), mainId: z.string(),
  worlds: z.array(z.object({ id: z.string(), role: z.string() })) });
const learningSchema = z.object({ stage: z.string().optional(), proposalId: z.string().optional() });
const samples: unknown[] = [], errors: string[] = [];
const started = Date.now();
async function get(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
while (true) {
  const at = Date.now();
  try {
    const [session, learning] = await Promise.all([
      get('/api/session').then(value => sessionSchema.parse(value)),
      get('/api/learning/status').then(value => learningSchema.parse(value)),
    ]);
    const roles = new Map(session.worlds.map(world => [world.id, world.role]));
    const worlds = [];
    let cursor: string | undefined;
    do {
      const page = await Sandbox.listWith(builder => { builder.limit(100); return cursor ? builder.cursor(cursor) : builder; });
      for (const handle of page.sandboxes) {
        const parsed = config.parse(JSON.parse(handle.configJson));
        worlds.push({ name: handle.name, identity: handle.id, status: handle.status, cpus: parsed.resources.cpus,
          memoryMiB: parsed.resources.memory_mib, sessionRole: roles.get(handle.name),
          app: parsed.labels.app, evaluationOwner: parsed.labels['evaluation-owner'], executorRun: parsed.labels['executor-run'] });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const snapshotCount = (await Snapshot.list()).length;
    samples.push({ at: new Date(at).toISOString(), elapsedSeconds: (at - started) / 1000, sampleMs: Date.now() - at,
      session: { running: session.running, stage: session.stage, mainId: session.mainId }, learning, worlds, snapshotCount });
  } catch (error) { errors.push(`${new Date(at).toISOString()}: ${String(error)}`); }
  if (Date.now() - started >= seconds * 1000) break;
  await new Promise(resolve => setTimeout(resolve, Math.min(10000, seconds * 1000 - (Date.now() - started))));
}
await writeFile(output, JSON.stringify({ format: 1, startedAt: new Date(started).toISOString(), durationSeconds: (Date.now() - started) / 1000,
  limitations: ['Catalog/API reads are not atomic; creation or deletion can occur between them.',
    'Configured memory is a capacity, not measured resident memory.',
    'Worlds missing from the live session can belong to evaluations, executors, retained sessions or other applications.',
    'Sampling every ten seconds can miss short-lived resources; this is not a proof of leak freedom.',
    'Snapshot count covers the runtime catalog, including other sessions.'], samples, errors }, null, 2));
console.log(JSON.stringify({ output, samples: samples.length, errors }));
if (errors.length) process.exitCode = 1;
