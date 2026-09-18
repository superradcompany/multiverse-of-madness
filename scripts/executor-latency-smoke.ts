import './runtime-env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Image, Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';
import { assertIsolatedConfig } from '../packages/executor-microsandbox/src/isolation.ts';

// Mechanical qualification only: same explicit input and program, clean VM per invocation.
// This deliberately does not replace the production executor or qualify arbitrary candidate code.
const root = await mkdtemp(join(tmpdir(), 'mom-executor-latency-'));
const owner = `mom-executor-benchmark-${randomUUID()}`;
const image = await Image.get('docker.io/library/node:24-alpine');
assert.match(image.manifestDigest!, /^sha256:[a-f0-9]{64}$/);
const imageRef = `docker.io/library/node@${image.manifestDigest}`;
const limits = { cpus: 1, memoryMiB: 256, timeoutMs: 20000, maxInputBytes: 4096, maxOutputBytes: 4096 };
const records: Array<{ name: string; identity?: string; released?: boolean }> = [];
const results: Array<{ mode: string; readyMs: number; uploadMs: number; executionMs: number; cleanupMs: number; totalMs: number }> = [];
let reference: string | undefined;
const save = () => writeFile(join(root, 'ownership.json'), JSON.stringify({ owner, reference, records, results }, null, 2));
const program = `import {existsSync,writeFileSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
let input='';for await(const chunk of process.stdin)input+=chunk;
const marker='/tmp/invocation-marker';const prior=existsSync(marker);writeFileSync(marker,'changed');
process.stdout.write(JSON.stringify({n:JSON.parse(input).n+1,prior,uid:process.getuid(),interfaces:Object.keys(networkInterfaces())}));`;
async function create(name: string) {
  const record = { name, identity: undefined as string | undefined, released: false }; records.push(record); await save();
  const sandbox = await Sandbox.builder(name).image(imageRef).detached(true).disableNetwork()
    .memory(256).maxMemory(256).cpus(1).maxCpus(1).rootDisk(256).label('benchmark-owner', owner).create();
  record.identity = sandbox.id; await save(); return sandbox;
}
async function cleanup(record: typeof records[number]) {
  if (record.released) return;
  try {
    const handle = await Sandbox.get(record.name);
    if (record.identity) assert.equal(handle.id, record.identity);
    else assert.equal((handle.config().labels as Record<string, string> | undefined)?.['benchmark-owner'], owner);
    await handle.destroy({ force: true, timeoutMs: 10000 });
  } catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error; }
  record.released = true; await save();
}
try {
  for (let i = 0; i < 3; i++) {
    const start = performance.now(); const sandbox = await create(`${owner}-fresh-${i}`); const ready = performance.now();
    assertIsolatedConfig(await sandbox.config(), limits);
    await sandbox.fs().write('/benchmark.mjs', program); const uploaded = performance.now();
    const result = await sandbox.execWith('env', options => options.args(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'node', '/benchmark.mjs']).user('1000:1000').timeout(10000).stdinBytes(Buffer.from('{"n":6}')));
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout()), { n: 7, prior: false, uid: 1000, interfaces: ['lo'] });
    const executed = performance.now(); await cleanup(records.at(-1)!);
    results.push({ mode: 'fresh', readyMs: ready - start, uploadMs: uploaded - ready, executionMs: executed - uploaded, cleanupMs: performance.now() - executed, totalMs: performance.now() - start });
  }
  const template = await create(`${owner}-template`);
  assertIsolatedConfig(await template.config(), limits);
  await template.fs().write('/benchmark.mjs', program);
  const captured = await Snapshot.builder('clean').group(owner).fromSandbox(template.name).full().create();
  reference = captured.reference; await save();
  await cleanup(records.at(-1)!);
  for (let i = 0; i < 3; i++) {
    const record = { name: `${owner}-clone-${i}`, identity: undefined as string | undefined, released: false }; records.push(record); await save();
    const start = performance.now();
    const sandbox = await Sandbox.restore(reference).name(record.name).forked().restore();
    record.identity = sandbox.id; await save(); const ready = performance.now();
    assertIsolatedConfig(await sandbox.config(), limits);
    const result = await sandbox.execWith('env', options => options.args(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'node', '/benchmark.mjs']).user('1000:1000').timeout(10000).stdinBytes(Buffer.from('{"n":6}')));
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout()), { n: 7, prior: false, uid: 1000, interfaces: ['lo'] });
    const executed = performance.now(); await cleanup(record);
    results.push({ mode: 'clean-snapshot', readyMs: ready - start, uploadMs: 0, executionMs: executed - ready, cleanupMs: performance.now() - executed, totalMs: performance.now() - start });
  }
} finally {
  const failed = (await Promise.allSettled(records.map(cleanup))).filter(result => result.status === 'rejected');
  if (!failed.length && reference) { await Snapshot.remove(reference); reference = undefined; await save(); }
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), `Benchmark cleanup incomplete; ownership: ${root}`);
}
for (const record of records) await assert.rejects(Sandbox.get(record.name), SandboxNotFoundError);
assert.equal((await Snapshot.list()).filter(snapshot => snapshot.group === owner).length, 0);
await writeFile(join(root, 'results.json'), JSON.stringify({ image: imageRef, results }, null, 2));
console.log(JSON.stringify({ passed: true, root, results }));
