import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord, type ExecutorTimings } from '../packages/executor-microsandbox/src/executor.ts';

// Actual production executor, mechanical program, no model calls or live-game mutations.
// Compare each phase under one versus four concurrent invocations, interleaving batches.
const directory = await mkdtemp(join(tmpdir(), 'mom-executor-load-'));
const image = await Image.get('docker.io/library/node:24-alpine');
assert.match(image.manifestDigest!, /^sha256:[a-f0-9]{64}$/);
const records = new Map<string, ExecutorRunRecord>();
const journal = new JsonFileStore<ExecutorRunRecord[]>(join(directory, 'runs.json'), value => value as ExecutorRunRecord[]);
const executor = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  records.set(record.id, structuredClone(record)); await journal.save([...records.values()]);
} });
const artifact = await new ExecutableStore(join(directory, 'artifacts')).put({ format: 1, runtime: 'node-typescript',
  entrypoint: 'main.ts', files: {
    'lib/calculate.ts': 'export const increment = (n: number) => n + 1;',
    'main.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { increment } from './lib/calculate.ts';
export default (input: { n: number }) => {
  const prior = existsSync('/tmp/invocation-marker'); writeFileSync('/tmp/invocation-marker', 'changed');
  return { value: increment(input.n), prior, uid: process.getuid!(), interfaces: Object.keys(networkInterfaces()) };
}`,
  } });
const limits = { timeoutMs: 20_000, memoryMiB: 256, cpus: 1, maxInputBytes: 4096, maxOutputBytes: 4096 };
const batches: Array<{ width: number; elapsedMs: number; ids: string[] }> = [];
try {
  for (const width of [1, 4, 4, 1, 1, 4]) {
    const started = performance.now();
    const results = await Promise.allSettled(Array.from({ length: width }, async (_, n) => {
      const result = await executor.execute(artifact, { n }, limits, new AbortController().signal);
      assert.deepEqual(result.value, { value: n + 1, prior: false, uid: 1000, interfaces: ['lo'] });
      const record = records.get(result.receipt.runtime.id)!;
      assert.equal(record.phase, 'released'); assert.ok(record.timings);
      for (const ms of Object.values(record.timings)) assert.ok(Number.isFinite(ms) && ms >= 0);
      assert.ok(Math.abs(Object.values(record.timings).reduce((sum, ms) => sum + ms, 0) - result.receipt.elapsedMs) < 2);
      return record.id;
    }));
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Executor load smoke failed');
    batches.push({ width, elapsedMs: performance.now() - started,
      ids: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []) });
  }
} finally {
  await Promise.all([...records.values()].filter(record => record.phase !== 'released').map(record => executor.recover(record)));
  for (const record of records.values()) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
}
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) };
}
const summary = [1, 4].map(width => {
  const runs = batches.filter(batch => batch.width === width).flatMap(batch => batch.ids.map(id => records.get(id)!));
  return { width, total: distribution(runs.map(run => run.receipt!.elapsedMs)),
    phases: Object.fromEntries((['createMs', 'uploadMs', 'executeMs', 'cleanupMs'] satisfies Array<keyof ExecutorTimings>)
      .map(phase => [phase, distribution(runs.map(run => run.timings![phase]))])) };
});
const report = { passed: true, image: executor.version, allVmsRemoved: records.size, batches, summary,
  limitations: ['Host wall time from a mechanical program, not Jev latency or browser FPS.',
    'Small interleaved sample on a shared host; concurrent workload affects results.',
    'Creation includes identity journaling and isolation checks; final receipt journal flush is outside per-run elapsed time.'] };
await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, ...report }));
