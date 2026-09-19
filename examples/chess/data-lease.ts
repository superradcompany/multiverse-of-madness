import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireDataLease } from '../shared/server/data-lease.ts';

const markerSchema = z.strictObject({
  version: z.literal(2), pid: z.number().int().positive().safe(), token: z.string().uuid(),
  host: z.string(), directory: z.string(),
});

/** Local process ownership with an exclusive marker that also excludes older chess hosts. */
export async function acquireChessDataLease(directory: string) {
  const lease = await acquireDataLease(directory);
  const path = join(lease.directory, '.owner');
  const marker = { version: 2 as const, pid: process.pid, token: randomUUID(), host: hostname(), directory: lease.directory };
  const temporary = join(lease.directory, `.owner-preparing-${marker.token}`);
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    // A newer owner must hold the kernel lease. The marker still excludes old
    // CLI/web hosts, which only know exclusive file creation. Never reclaim an
    // old, malformed, moved or foreign-host marker from a PID guess.
    const prior = await fileIdentity(path);
    if (prior) {
      if (!prior.isFile()) throw ownershipError();
      const contents = await readFile(path, 'utf8');
      let value: unknown;
      try { value = JSON.parse(contents); } catch { throw ownershipError(); }
      const saved = markerSchema.safeParse(value);
      if (!saved.success || saved.data.host !== marker.host || saved.data.directory !== lease.directory || !processAbsent(saved.data.pid)) throw ownershipError();
      if (!sameFile(prior, await fileIdentity(path))) throw ownershipError();
      await unlink(path);
    }
    // Publish a complete marker atomically, without replacing a legacy owner
    // that could have acquired the filename while we were checking it.
    const preparing = await open(temporary, 'wx', 0o600);
    try { identity = await preparing.stat(); await preparing.writeFile(JSON.stringify(marker)); }
    finally { await preparing.close(); }
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    try {
      if (identity && sameFile(identity, await fileIdentity(path))) await unlink(path);
      if (identity && sameFile(identity, await fileIdentity(temporary))) await unlink(temporary);
    } finally { await lease.release(); }
    throw error;
  }
  let releasing: Promise<void> | undefined;
  return { directory: lease.directory, release(): Promise<void> {
    return releasing ??= (async () => {
      // A replacement marker belongs to someone else; never unlink it.
      if (sameFile(identity!, await fileIdentity(path))) await unlink(path);
      await lease.release();
    })().catch(error => { releasing = undefined; throw error; });
  } };
}

function ownershipError() {
  return new Error('Cannot own chess session: an existing owner marker cannot be verified as a stopped local lease. Verify its owner before removing .owner.');
}
async function fileIdentity(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function sameFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>> | undefined) {
  return after?.isFile() && before.dev === after.dev && before.ino === after.ino;
}
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
