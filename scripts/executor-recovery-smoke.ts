import './runtime-env.ts';
import assert from 'node:assert/strict';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { JsonFileStore, executableArtifact } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../packages/executor-microsandbox/src/executor.ts';

const store = new JsonFileStore('.cache/executor-recovery-smoke.json', value => value as ExecutorRunRecord);
const image = await Image.get('docker.io/library/node:24-alpine');
assert.ok(image.manifestDigest);
const mode = process.argv[2];
const provider = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  await store.save(record); await store.flush();
  if (mode === 'create' && record.phase === 'running') {
    console.log(`Saved interrupted executor ${record.id}; exiting before source dispatch.`);
    process.exit(0);
  }
} });
if (mode === 'create') {
  const previous = await store.load();
  if (previous && previous.phase !== 'released') throw new Error('Reconcile the previous executor smoke before starting another');
  const artifact = executableArtifact({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'export default () => null;' } });
  await provider.execute(artifact, {}, { timeoutMs: 20_000, cpus: 1, memoryMiB: 256, maxInputBytes: 1024, maxOutputBytes: 1024 }, new AbortController().signal);
  assert.fail('Expected creating process to exit at the durable runtime record');
} else if (mode === 'recover') {
  const record = await store.load(); assert.ok(record?.identity); assert.equal(record.phase, 'running');
  assert.equal((await Sandbox.get(record.id)).id, record.identity);
  await assert.rejects(provider.recover({ ...record, identity: 'deliberately-different-identity' }), /replaced/);
  assert.equal((await Sandbox.get(record.id)).id, record.identity);
  await provider.recover(record);
  await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  assert.equal((await store.load())!.phase, 'released');
  console.log('PASS: new host recovered the exact interrupted VM; mismatched identity was refused and actual runtime removed.');
} else throw new Error('Expected create or recover');
