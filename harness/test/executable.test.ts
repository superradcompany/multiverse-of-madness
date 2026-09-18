import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutableStore, executableArtifact, verifyExecutableArtifact } from '../src/node/executable-store.ts';
import { validateExecutableSource, validateExecutorLimits, type ExecutableSource } from '../src/executable.ts';

const source = (): ExecutableSource => ({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': 'export default (input: { n: number }) => ({ n: input.n + 1 });' } });
test('executable source is content-addressed data, never code loaded on the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'executable-store-'));
  try {
    const store = new ExecutableStore(root), input = source();
    input.files['main.ts'] = `throw new Error('must never execute on host');`;
    const result = await store.put(input); input.files['main.ts'] = 'tampered';
    assert.deepEqual(await store.get(result.revision), result);
    const reopened = new ExecutableStore(root); assert.deepEqual(await reopened.get(result.revision), result);
    const changed = await store.put(source()); assert.notDeepEqual(changed.revision, result.revision);
    const duplicates = await Promise.all([store.put(source()), store.put(source())]); assert.deepEqual(duplicates[0], duplicates[1]);
    assert.equal((await readdir(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid manifests cannot traverse paths, smuggle files or bypass the size bound', () => {
  const accessor = Object.defineProperty(source(), 'files', { enumerable: true, get: () => assert.fail('source accessors must not run on host') });
  assert.throws(() => executableArtifact(accessor), /enumerable data/);
  for (const path of ['../host.ts', '/host.ts', 'a/../host.ts', 'a//host.ts', 'a/./host.ts', 'a\\host.ts', 'a.ts\u0000', 'a.js']) {
    const input = source(); input.files[path] = 'text'; assert.throws(() => validateExecutableSource(input));
  }
  const missing = source(); missing.entrypoint = 'missing.ts'; assert.throws(() => validateExecutableSource(missing));
  const large = source(); large.files['main.ts'] = 'x'.repeat(1_048_576); assert.throws(() => validateExecutableSource(large), /size limit/);
  const collision = source(); collision.files['main.ts/child.ts'] = 'text'; assert.throws(() => validateExecutableSource(collision), /directory/);
  assert.throws(() => verifyExecutableArtifact({ ...executableArtifact(source()), source: { ...source(), files: { 'main.ts': 'tampered' } } }), /identity mismatch/);
});
test('damaged stored artifacts and forged requested identities are refused without overwriting evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'executable-store-'));
  try {
    const store = new ExecutableStore(root), saved = await store.put(source());
    await writeFile(join(root, `${saved.revision.version.slice(7)}.json`), JSON.stringify({ ...saved, source: { ...saved.source, files: { 'main.ts': 'other source' } } }));
    await assert.rejects(store.get(saved.revision), /identity mismatch/);
    await assert.rejects(store.put(source()), /identity mismatch/);
    await assert.rejects(store.get({ id: 'learning-executor', version: '../../secret' }), /Invalid executable identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('executor limits are finite host-owned limits, with no unrecognized settings', () => {
  const limits = { timeoutMs: 1000, cpus: 1, memoryMiB: 256, maxInputBytes: 4096, maxOutputBytes: 4096 };
  validateExecutorLimits(limits);
  for (const patch of [{ timeoutMs: Infinity }, { timeoutMs: 0 }, { cpus: 5 }, { memoryMiB: 64 }, { maxOutputBytes: 1_048_577 }, { mounts: [] }]) assert.throws(() => validateExecutorLimits({ ...limits, ...patch }));
});
