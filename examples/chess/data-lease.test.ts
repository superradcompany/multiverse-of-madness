import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireChessDataLease } from './data-lease.ts';

test('chess process ownership excludes old hosts and canonical-path aliases until release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-owner-')), directory = join(root, 'session'), alias = join(root, 'alias');
  let lease: Awaited<ReturnType<typeof acquireChessDataLease>> | undefined;
  try {
    lease = await acquireChessDataLease(directory);
    const before = await readFile(join(directory, '.owner'), 'utf8');
    const marker = JSON.parse(before);
    assert.equal(marker.version, 2); assert.equal(marker.pid, process.pid);
    assert.equal(marker.directory, lease.directory); assert.equal(marker.host, hostname());
    await symlink(directory, alias, 'dir');
    await assert.rejects(acquireChessDataLease(alias), /already owned/);
    await assert.rejects(open(join(directory, '.owner'), 'wx'), { code: 'EEXIST' });
    assert.equal(await readFile(join(directory, '.owner'), 'utf8'), before);
    await Promise.all([lease.release(), lease.release()]); lease = undefined;
    await assert.rejects(readFile(join(directory, '.owner')), { code: 'ENOENT' });
    lease = await acquireChessDataLease(alias);
    assert.notEqual(JSON.parse(await readFile(join(directory, '.owner'), 'utf8')).token, marker.token);
  } finally { await lease?.release(); await rm(root, { recursive: true, force: true }); }
});

test('a killed chess lease owner can be reopened without changing saved gameplay', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-owner-crash-'));
  let child: ChildProcess | undefined;
  try {
    const cli = fileURLToPath(new URL('./main.ts', import.meta.url));
    const run = (args: string[]) => promisify(execFile)(process.execPath,
      ['--import', 'tsx', cli, ...args, '--directory', root, '--model', 'fixture'], { timeout: 5000 });
    await run(['run', '--cycles', '2', '--guide', 'Preserve this session']);
    const saved = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./test-support/lease-owner.ts', import.meta.url)), root],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.on('data', part => { errors += part; });
    const signal = AbortSignal.timeout(5000);
    const ready = await Promise.race([
      once(child, 'message', { signal }),
      once(child, 'exit', { signal }).then(() => { throw new Error(`Lease fixture exited before readiness: ${errors}`); }),
    ]);
    assert.deepEqual(ready[0], { ready: true });
    const old = await readFile(join(root, '.owner'), 'utf8');
    await assert.rejects(acquireChessDataLease(root), /already owned/);
    await assert.rejects(run(['status']), /already owned/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(await readFile(join(root, '.owner'), 'utf8'), old);
    const reopened = JSON.parse((await run(['status'])).stdout);
    assert.equal(reopened.provider, 'deterministic workflow fixture');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'session.json'), 'utf8')), saved);
    await assert.rejects(readFile(join(root, '.owner')), { code: 'ENOENT' });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy, foreign, malformed and live-PID owner markers are never silently reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-owner-refusal-'));
  let lease: Awaited<ReturnType<typeof acquireChessDataLease>> | undefined;
  try {
    // Obtain the canonical directory without leaving a lease or marker behind.
    lease = await acquireChessDataLease(root); const directory = lease.directory; await lease.release(); lease = undefined;
    const current = { version: 2, pid: process.pid, token: randomUUID(), host: hostname(), directory };
    for (const value of [JSON.stringify({ pid: 99999999, token: randomUUID() }), '{',
      JSON.stringify({ ...current, host: 'another-host' }), JSON.stringify({ ...current, directory: root + '-other' }), JSON.stringify(current)]) {
      await writeFile(join(root, '.owner'), value);
      await assert.rejects(acquireChessDataLease(root));
      assert.equal(await readFile(join(root, '.owner'), 'utf8'), value);
    }
    await rm(join(root, '.owner')); lease = await acquireChessDataLease(root);
  } finally { await lease?.release(); await rm(root, { recursive: true, force: true }); }
});

test('owner symlinks and replacement markers remain untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-owner-replacement-')), target = join(root, 'other');
  let lease: Awaited<ReturnType<typeof acquireChessDataLease>> | undefined;
  try {
    await writeFile(target, 'preserve'); await symlink(target, join(root, '.owner'));
    await assert.rejects(acquireChessDataLease(root), /cannot be verified/);
    assert.equal(await readFile(target, 'utf8'), 'preserve');
    await rm(join(root, '.owner')); lease = await acquireChessDataLease(root);
    await rename(join(root, '.owner'), join(root, 'old-owner'));
    await writeFile(join(root, '.owner'), 'replacement');
    await lease.release(); lease = undefined;
    assert.equal(await readFile(join(root, '.owner'), 'utf8'), 'replacement');
    await assert.rejects(acquireChessDataLease(root));
  } finally { await lease?.release(); await rm(root, { recursive: true, force: true }); }
});
