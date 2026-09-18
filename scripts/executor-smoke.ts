import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { ExecutorLimits } from '@multiverse/gameplay-harness';
import { MicrosandboxExecutor, ExecutorFailure, type ExecutorRunRecord } from '../packages/executor-microsandbox/src/executor.ts';

const root = `.cache/executor-smoke-${Date.now()}`;
await mkdir(root, { recursive: true });
const image = await Image.get('docker.io/library/node:24-alpine');
assert.match(image.manifestDigest!, /^sha256:/);
const records: ExecutorRunRecord[] = [];
let cancelOnStart: AbortController | undefined;
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
const journal = new JsonFileStore(join(root, 'runs.json'), value => value as ExecutorRunRecord[]);
const executor = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  const index = records.findIndex(saved => saved.id === record.id);
  if (index === -1) records.push(record); else records[index] = record;
  await journal.save(records);
  if (record.phase === 'running' && cancelOnStart) { const control = cancelOnStart; cancelOnStart = undefined; cancelTimer = setTimeout(() => control.abort(new Error('Host cancellation test')), 500); }
} });
const store = new ExecutableStore(join(root, 'artifacts'));
const limits: ExecutorLimits = { timeoutMs: 20_000, memoryMiB: 256, cpus: 1, maxInputBytes: 16_384, maxOutputBytes: 16_384 };
const source = async (text: string) => store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': text } });
const hostMarker = join(tmpdir(), `mom-executor-host-${randomUUID()}`);
await writeFile(hostMarker, 'host-only');
process.env.MOM_EXECUTOR_HOST_ONLY = 'host-only';
try {
  const normal = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'lib/math.ts': 'export const increment = (n: number) => n + 1;', 'main.ts': `import { existsSync } from 'node:fs';
    import { increment } from './lib/math.ts';
    import { networkInterfaces } from 'node:os';
    export default (input: { n: number; hostMarker: string }) => ({ result: increment(input.n),
      hostFileVisible: existsSync(input.hostMarker), hostEnvironmentVisible: Boolean(process.env.MOM_EXECUTOR_HOST_ONLY),
      interfaces: Object.keys(networkInterfaces()), uid: process.getuid!() });` } });
  const result = await executor.execute(normal, { n: 6, hostMarker }, limits, new AbortController().signal);
  assert.deepEqual(result.value, { result: 7, hostFileVisible: false, hostEnvironmentVisible: false, interfaces: ['lo'], uid: 1000 });
  assert.equal(result.receipt.status, 'complete');
  console.log('PASS: TypeScript ran in a real VM as uid 1000, without host files, host environment or a network interface.');

  const flood = await source(`export default () => { process.stdout.write('x'.repeat(32768)); return null; };`);
  await assert.rejects(executor.execute(flood, {}, { ...limits, maxOutputBytes: 256 }, new AbortController().signal), error => {
    assert.ok(error instanceof ExecutorFailure); assert.match(error.receipt.error!, /output exceeds/); return true;
  });
  console.log('PASS: excessive output was stopped and cleaned up.');

  const infinite = await source(`export default () => { while (true) {} };`);
  await assert.rejects(executor.execute(infinite, {}, { ...limits, timeoutMs: 3000 }, new AbortController().signal), error => {
    assert.ok(error instanceof ExecutorFailure); assert.equal(error.receipt.status, 'timeout'); return true;
  });
  console.log('PASS: an infinite executor hit its deadline and the whole VM was removed.');

  const cancelled = new AbortController(); cancelOnStart = cancelled;
  const running = await source(`export default () => { process.stdout.write('running'); while (true) {} };`);
  await assert.rejects(executor.execute(running, {}, limits, cancelled.signal), error => {
    assert.ok(error instanceof ExecutorFailure); assert.equal(error.receipt.status, 'cancelled'); assert.ok(error.receipt.stdoutBytes > 0); return true;
  });
  console.log('PASS: explicit cancellation joined a running guest and removed its VM.');

  assert.ok(records.every(record => record.phase === 'released'));
  for (const record of records) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  assert.deepEqual(await journal.load(), records);
  console.log(JSON.stringify({ artifacts: root, receipts: records.map(record => record.receipt) }, null, 2));
} finally {
  clearTimeout(cancelTimer);
  delete process.env.MOM_EXECUTOR_HOST_ONLY;
  await rm(hostMarker, { force: true });
  await Promise.all(records.filter(record => record.phase !== 'released').map(record => executor.recover(record)));
}
