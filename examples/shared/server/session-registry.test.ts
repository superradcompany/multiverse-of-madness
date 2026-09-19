import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionRegistry, type SessionLaunch } from './session-registry.ts';
import { sessionControl } from './session-control.ts';
import { serveSessions } from './session-server.ts';
import { sessionPage } from './session-page.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mom-sessions-'));
  const hosts: Server[] = [], launches: SessionLaunch[] = [];
  const launch = async (request: SessionLaunch) => {
    launches.push(request);
    const control = sessionControl(request.entry.port, { MOM_SESSION_MANAGER_URL: request.managerUrl, MOM_SESSION_TOKEN: request.entry.token });
    const server = createServer((req, res) => { if (!control.handle(req, res)) { res.writeHead(404); res.end(); } });
    hosts.push(server);
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(request.entry.port, '127.0.0.1', done); });
    control.ready(async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
  };
  return { directory, hosts, launches, launch, async close() {
    await Promise.all(hosts.map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); })));
    await rm(directory, { recursive: true, force: true });
  } };
}
async function eventually(work: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await work()) return; await new Promise(done => setTimeout(done, 20)); }
  assert.fail('Fixture did not reach expected state');
}
function foreignHost(url: string, token?: string): Promise<number | undefined> {
  return new Promise((done, reject) => {
    const req = request(url, { headers: { host: 'evil.example', ...(token ? { 'x-session-token': token } : {}) } }, res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

test('creation is offline; parallel sessions retain distinct directories, ports and private identities across manager restart', async () => {
  const setup = await fixture(); let registry: SessionRegistry | undefined;
  try {
    registry = await SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' });
    const [first, second] = await Promise.all([registry.create({ game: 'doom', title: 'First' }), registry.create({ game: 'chess', title: 'Second', learning: true })]);
    assert.equal(setup.launches.length, 0);
    assert.deepEqual((await registry.list()).map(run => run.status), ['stopped', 'stopped']);
    await Promise.all([registry.start(first), registry.start(first), registry.start(second)]);
    assert.equal(setup.launches.length, 2);
    const [a, b] = setup.launches as [SessionLaunch, SessionLaunch];
    assert.notEqual(a.directory, b.directory); assert.notEqual(a.entry.port, b.entry.port); assert.notEqual(a.entry.token, b.entry.token);
    const saved = { guide: 'Session-specific goal', history: ['selected-future'], replay: 'retained', learning: { revision: 2 } };
    await writeFile(join(a.directory, 'fixture-state.json'), JSON.stringify(saved));
    await registry.rename(first, 'Renamed run');
    await registry.close(); registry = undefined;
    // Backend stays live, and the catalog reconnects without launching it again.
    registry = await SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' });
    const view = await registry.list();
    assert.equal(view.find(run => run.id === first)?.title, 'Renamed run');
    assert.deepEqual(view.map(run => run.status), ['ready', 'ready']);
    assert.equal(JSON.stringify(view).includes(a.entry.token), false);
    assert.equal(JSON.stringify(view).includes(setup.directory), false);
    await registry.start(first); assert.equal(setup.launches.length, 2);
    await registry.stop(first);
    await eventually(async () => (await registry!.list()).find(run => run.id === first)?.status === 'stopped');
    assert.equal((await registry.list()).find(run => run.id === second)?.status, 'ready');
    await registry.start(first);
    assert.equal(setup.launches.length, 3);
    assert.equal(setup.launches[2]!.directory, a.directory);
    assert.deepEqual(JSON.parse(await readFile(join(a.directory, 'fixture-state.json'), 'utf8')), saved);
  } finally { await registry?.close(); await setup.close(); }
});

test('an unrelated listener cannot be adopted or stopped, and invalid catalog or creation input fails closed', async () => {
  const setup = await fixture(); let registry: SessionRegistry | undefined;
  try {
    registry = await SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' });
    await assert.rejects(registry.create({ game: 'doom', title: 'Learning', learning: true }), /Doom learning/);
    await assert.rejects(registry.create({ game: 'chess', title: '../', directory: '/tmp/other' } as never));
    const id = await registry.create({ game: 'chess', title: 'Safe' });
    const view = (await registry.list())[0]!;
    let stopRequests = 0;
    const foreign = createServer((req, res) => { if (req.method === 'POST') stopRequests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ state: 'ready', identity: 'a'.repeat(64) })); });
    setup.hosts.push(foreign);
    await new Promise<void>(done => foreign.listen(Number(new URL(view.url).port), '127.0.0.1', done));
    assert.equal((await registry.list())[0]!.status, 'unavailable');
    await assert.rejects(registry.start(id), /occupied/);
    await assert.rejects(registry.stop(id), /ready/);
    assert.equal(setup.launches.length, 0); assert.equal(stopRequests, 0);
    await assert.rejects(SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' }), /already owned/);
    await registry.close(); registry = undefined;
    const path = join(setup.directory, 'sessions.json'), catalog = JSON.parse(await readFile(path, 'utf8'));
    catalog.sessions.push(catalog.sessions[0]); await writeFile(path, JSON.stringify(catalog));
    await assert.rejects(SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' }), /Duplicate session/);
    catalog.version = 2; catalog.sessions.pop(); await writeFile(path, JSON.stringify(catalog));
    await assert.rejects(SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' }));
  } finally { await registry?.close(); await setup.close(); }
});

test('failed process launch is retryable without creating a new identity or discarding saved data', async () => {
  const setup = await fixture(); let registry: SessionRegistry | undefined; let failing = true;
  try {
    registry = await SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/', launch: async request => { if (failing) throw new Error('Fixture launch failed'); await setup.launch(request); } });
    const id = await registry.create({ game: 'chess', title: 'Retry' });
    await assert.rejects(registry.start(id), /launch failed/);
    assert.equal((await registry.list())[0]!.status, 'stopped');
    failing = false; await registry.start(id);
    assert.equal((await registry.list())[0]!.id, id);
    assert.equal((await registry.list())[0]!.status, 'ready');
  } finally { await registry?.close(); await setup.close(); }
});

test('a detached fixture process survives manager closure and a reopened registry stops that exact child', async () => {
  const setup = await fixture(); let registry: SessionRegistry | undefined; let child: ChildProcess | undefined;
  try {
    const launch = async ({ entry, managerUrl }: SessionLaunch) => {
      child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/managed-host.ts', import.meta.url))], {
        detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(entry.port), MOM_SESSION_MANAGER_URL: managerUrl, MOM_SESSION_TOKEN: entry.token },
      });
      await new Promise<void>((done, reject) => { child!.once('spawn', done); child!.once('error', reject); }); child.unref();
    };
    const options = { directory: setup.directory, managerUrl: 'http://127.0.0.1:4316/', launch };
    registry = await SessionRegistry.open(options);
    const id = await registry.create({ game: 'chess', title: 'Detached HTTP fixture' }); await registry.start(id);
    await eventually(async () => (await registry!.list())[0]!.status === 'ready');
    const pid = child!.pid!; await registry.close(); registry = undefined;
    process.kill(pid, 0);
    registry = await SessionRegistry.open(options);
    assert.equal((await registry.list())[0]!.status, 'ready');
    await registry.stop(id);
    await eventually(async () => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } });
    assert.equal((await registry.list())[0]!.status, 'stopped');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child!.once('exit', () => done())); child.kill('SIGKILL'); await exited;
    }
    await registry?.close(); await setup.close();
  }
});

test('host control requires private identity, rejects browser cross-origin requests, and exposes only the manager URL publicly', async () => {
  const setup = await fixture(); const registry = await SessionRegistry.open({ ...setup, managerUrl: 'http://127.0.0.1:4316/' });
  try {
    const id = await registry.create({ game: 'chess', title: 'Controls' }); await registry.start(id);
    const { token, port } = setup.launches[0]!.entry, url = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${url}/api/session-manager`)).json(), { url: 'http://127.0.0.1:4316/' });
    const invalidHeaders: Record<string, string>[] = [{}, { 'x-session-token': 'f'.repeat(64) }, { 'x-session-token': 'é'.repeat(64) }, { 'x-session-token': token, origin: 'http://evil.example' }];
    for (const headers of invalidHeaders) {
      assert.equal((await fetch(`${url}/api/session-control`, { method: 'POST', headers })).status, 403);
    }
    assert.equal(await foreignHost(`${url}/api/session-control`, token), 403);
    assert.equal((await registry.list())[0]!.status, 'ready');
    assert.throws(() => sessionControl(port, { MOM_SESSION_MANAGER_URL: 'https://example.com/', MOM_SESSION_TOKEN: token }), /local HTTP/);
  } finally { await registry.close(); await setup.close(); }
});

test('HTTP sessions page creates, starts, renames and stops only through same-origin CSRF-protected forms', async () => {
  const setup = await fixture(); const manager = await serveSessions({ port: 0, ...setup });
  try {
    const home = await fetch(manager.url), html = await home.text();
    assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    // no-referrer makes Chromium send Origin: null on form navigation.
    assert.equal(home.headers.get('referrer-policy'), 'same-origin');
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)![1]!;
    const post = (fields: Record<string, string>, origin: string | undefined = new URL(manager.url).origin) => fetch(manager.url, {
      method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...fields }), redirect: 'manual',
    });
    const creation = { action: 'create', game: 'chess', title: '<script>alert(1)</script>' };
    assert.equal((await post(creation, 'http://evil.example')).status, 403);
    assert.equal((await post({ ...creation, csrf: '0'.repeat(64) })).status, 403);
    assert.equal((await post(creation, '')).status, 403);
    assert.equal((await post(creation)).status, 303);
    assert.equal(setup.launches.length, 0);
    const catalog = await (await fetch(`${manager.url}api/sessions`)).json() as { id: string }[];
    const id = catalog[0]!.id;
    const page = await (await fetch(manager.url)).text();
    assert.match(page, /&lt;script&gt;/); assert.doesNotMatch(page, /<script>/);
    assert.equal((await post({ action: 'start', id })).status, 303);
    assert.equal(setup.launches.length, 1);
    assert.equal((await post({ action: 'rename', id, title: 'Second name' })).status, 303);
    assert.match(await (await fetch(manager.url)).text(), /Second name/);
    assert.equal((await post({ action: 'stop', id })).status, 303);
    assert.equal(await foreignHost(manager.url), 403);
  } finally { await manager.close(); await setup.close(); }
});

test('page refreshes pending lifecycle states, while a settled page allows uninterrupted editing', () => {
  const base = { id: 'fixture', game: 'chess' as const, title: 'Game', learning: false, createdAt: '', url: 'http://127.0.0.1:1234/' };
  assert.match(sessionPage([{ ...base, status: 'starting' }], 'token', '', base.id), /http-equiv="refresh"/);
  assert.doesNotMatch(sessionPage([{ ...base, status: 'ready' }], 'token', '', base.id), /http-equiv="refresh"/);
  assert.match(sessionPage([{ ...base, status: 'unavailable' }], 'token'), /Owner unavailable/);
});
