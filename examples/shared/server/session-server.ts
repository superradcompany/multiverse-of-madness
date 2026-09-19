import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SessionRegistry, type RegistryOptions } from './session-registry.ts';
import { sessionPage } from './session-page.ts';

const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), title: z.string(), game: z.enum(['doom', 'chess']), learning: z.literal('true').optional() }),
  z.strictObject({ action: z.enum(['start', 'stop']), id: z.string().uuid() }),
  z.strictObject({ action: z.literal('rename'), id: z.string().uuid(), title: z.string() }),
]);
export async function serveSessions(options: { port: number; directory: string; launch?: RegistryOptions['launch'] }) {
  const csrf = randomBytes(32).toString('hex');
  let registry: SessionRegistry | undefined;
  let closing = false;
  let port = options.port;
  const server = createServer(async (req, res) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`))) { json(403, { error: 'Origin rejected' }); return; }
    if (!registry || closing) { json(503, { error: 'Sessions manager is unavailable' }); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/sessions') { json(200, await registry.list()); return; }
      if (req.method === 'GET' && url.pathname === '/sessions.css') {
        const css = await readFile(new URL('./sessions.css', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/css' }); res.end(css); return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const html = sessionPage(await registry.list(), csrf, url.searchParams.get('notice') ?? '', url.searchParams.get('watch') ?? undefined);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'same-origin' });
        res.end(html); return;
      }
      if (req.method === 'POST' && url.pathname === '/') {
        if (!req.headers.origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { json(403, { error: 'Same-origin form required' }); return; }
        let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 8192) throw new Error('Request too large'); }
        const fields = new URLSearchParams(body), supplied = fields.get('csrf');
        if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) { json(403, { error: 'Reload the sessions page before submitting' }); return; }
        fields.delete('csrf');
        if ([...fields.keys()].length !== new Set(fields.keys()).size) throw new Error('Duplicate form fields');
        const command = commandSchema.parse(Object.fromEntries(fields));
        let watch: string | undefined;
        if (command.action === 'create') await registry.create({ game: command.game, title: command.title, learning: command.learning === 'true' });
        else if (command.action === 'rename') await registry.rename(command.id, command.title);
        else { await registry[command.action](command.id); watch = command.id; }
        res.writeHead(303, { location: watch ? `/?watch=${watch}` : '/' }); res.end(); return;
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Session request failed';
      if (req.method === 'POST') { res.writeHead(303, { location: `/?notice=${encodeURIComponent(message)}` }); res.end(); }
      else json(500, { error: message });
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  try { registry = await SessionRegistry.open({ ...options, managerUrl: url }); }
  catch (error) { await new Promise<void>(done => server.close(() => done())); throw error; }
  return { url, async close() {
    closing = true;
    await new Promise<void>(done => server.close(() => done()));
    await registry!.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = await serveSessions({ port: z.coerce.number().int().min(1024).max(65535).parse(process.env.SESSIONS_PORT ?? 4316), directory: resolve(process.env.SESSIONS_DATA_DIR ?? '.data/sessions') });
  console.log(`Games & sessions: ${host.url} (no game backends started)`);
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopped) return; stopped = true;
    void host.close().catch(error => { console.error(error); process.exitCode = 1; });
  });
}
