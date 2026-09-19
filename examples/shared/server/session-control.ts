import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

export const managedHostState = z.enum(['starting', 'ready', 'stopping', 'stop-failed']);
export type ManagedHostState = z.infer<typeof managedHostState>;

/** Private local control identity, distinct from the public navigation address. */
export function sessionControl(port: number, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.MOM_SESSION_MANAGER_URL !== undefined;
  let managerUrl: string | undefined, token: string | undefined;
  if (configured) {
    const url = new URL(env.MOM_SESSION_MANAGER_URL!);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Session manager must be a local HTTP origin');
    managerUrl = url.href;
    token = z.string().regex(/^[a-f0-9]{64}$/).parse(env.MOM_SESSION_TOKEN);
  }
  let state: ManagedHostState = 'starting';
  let shutdown: (() => Promise<void>) | undefined;
  return {
    ready(close: () => Promise<void>) { shutdown = close; state = 'ready'; },
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = req.url?.split('?')[0];
      if (path !== '/api/session-manager' && path !== '/api/session-control') return false;
      const json = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`))) { json(403, { error: 'Origin rejected' }); return true; }
      if (path === '/api/session-manager') {
        if (req.method !== 'GET') json(405, { error: 'GET required' });
        else json(200, { url: managerUrl ?? null });
        return true;
      }
      const supplied = req.headers['x-session-token'];
      if (!token || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(403, { error: 'Session identity rejected' }); return true; }
      if (req.method === 'GET') json(200, { state, identity: createHash('sha256').update(token).digest('hex') });
      else if (req.method === 'POST' && shutdown && state === 'ready') {
        state = 'stopping';
        res.once('finish', () => { void shutdown!().catch(error => { state = 'stop-failed'; console.error('Managed session shutdown failed:', error); }); });
        json(202, { state });
      } else json(409, { error: 'Session is not ready to stop', state });
      return true;
    },
  };
}
