import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';

/**
 * Kernel-owned local process lease, acquired before opening any application stores.
 * A hard crash releases the socket; no stale PID file needs to be stolen or deleted.
 * Hash collisions fail closed, so an unrelated listener can prevent acquisition.
 * This protects cooperating servers on this host, not stores shared between hosts.
 */
export async function acquireDataLease(directory: string): Promise<{ directory: string; release(): Promise<void> }> {
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const digest = createHash('sha256').update(canonical).digest();
  const port = 20000 + digest.readUInt32BE(0) % 20000;
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => { server.removeListener('listening', listening); reject(cause); };
      const listening = () => { server.removeListener('error', error); resolve(); };
      server.once('error', error); server.once('listening', listening);
      server.listen({ host: '127.0.0.1', port, exclusive: true });
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Session data is already owned by another local process (lease port ${port}). Stop that owner before reopening it. A port collision also fails closed.`, { cause });
    throw cause;
  }
  server.unref();
  let releasing: Promise<void> | undefined;
  return { directory: canonical, release: () => releasing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }) };
}
