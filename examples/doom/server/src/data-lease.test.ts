import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataLease } from './data-lease.ts';

test('one data directory has one local owner even through a symlink; release is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mom-data-lease-'));
  let lease: Awaited<ReturnType<typeof acquireDataLease>> | undefined;
  try {
    lease = await acquireDataLease(join(root, 'data')); await symlink(lease.directory, join(root, 'alias'));
    await assert.rejects(acquireDataLease(join(root, 'alias')), /already owned/);
    const releasing = lease.release(); assert.equal(lease.release(), releasing); await releasing;
    lease = await acquireDataLease(join(root, 'alias')); await lease.release();
  } finally { await lease?.release(); await rm(root, { recursive: true, force: true }); }
});

test('a hard-killed process releases ownership without deleting or stealing a lock file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mom-data-lease-crash-'));
  const child = fork(fileURLToPath(new URL('../test-support/data-lease-process.ts', import.meta.url)), [root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', value => { diagnostics += String(value); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lease fixture did not start: ' + diagnostics)), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Lease fixture exited: ' + diagnostics)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(acquireDataLease(root), /already owned/);
    child.kill('SIGKILL'); await exited;
    const next = await acquireDataLease(root); await next.release();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); }
});
