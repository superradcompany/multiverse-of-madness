import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { z } from 'zod';
import { acquireDataLease } from './data-lease.ts';
import { managedHostState } from './session-control.ts';

export const newSessionSchema = z.strictObject({
  game: z.enum(['doom', 'chess']), title: z.string().trim().min(1).max(80),
  learning: z.boolean().default(false),
});
const entrySchema = newSessionSchema.extend({
  id: z.string().uuid(), port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(),
});
const catalogSchema = z.strictObject({ version: z.literal(1), sessions: z.array(entrySchema) }).superRefine((value, ctx) => {
  for (const key of ['id', 'port', 'token'] as const) if (new Set(value.sessions.map(entry => entry[key])).size !== value.sessions.length) ctx.addIssue({ code: 'custom', message: `Duplicate session ${key}` });
});
type Entry = z.infer<typeof entrySchema>;
export type NewSession = z.input<typeof newSessionSchema>;
export type HostStatus = z.infer<typeof managedHostState> | 'stopped' | 'unavailable';
export interface SessionView { id: string; game: 'doom' | 'chess'; title: string; learning: boolean; createdAt: string; url: string; status: HostStatus }
export interface SessionLaunch { entry: Readonly<Entry>; directory: string; managerUrl: string }
export interface RegistryOptions {
  directory: string; managerUrl: string;
  /** Injection for offline process fixtures; production uses the actual game hosts. */
  launch?: (request: SessionLaunch) => Promise<void>;
}

/** One local writer owns the catalog. Hosts outlive the manager and are reclaimed by token, never PID. */
export class SessionRegistry {
  private operations = Promise.resolve();
  private closed = false;
  private launching = new Map<string, number>();
  private constructor(private readonly options: RegistryOptions, private readonly lease: Awaited<ReturnType<typeof acquireDataLease>>,
    private readonly store: JsonFileStore<z.infer<typeof catalogSchema>>, private entries: Entry[]) {}

  static async open(options: RegistryOptions): Promise<SessionRegistry> {
    const url = new URL(options.managerUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Manager URL must be a local HTTP origin');
    const lease = await acquireDataLease(options.directory);
    try {
      const store = new JsonFileStore(join(lease.directory, 'sessions.json'), value => catalogSchema.parse(value));
      const saved = await store.load();
      return new SessionRegistry({ ...options, managerUrl: url.href }, lease, store, saved?.sessions ?? []);
    } catch (error) { await lease.release(); throw error; }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Session registry is closed'));
    const result = this.operations.then(work);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private entry(id: string) { const entry = this.entries.find(item => item.id === id); if (!entry) throw new Error('Unknown session'); return entry; }
  private async save(entries: Entry[]) { await this.store.save({ version: 1, sessions: entries }); this.entries = entries; }
  async list(): Promise<SessionView[]> { return Promise.all(this.entries.map(async entry => ({
    id: entry.id, game: entry.game, title: entry.title, learning: entry.learning, createdAt: entry.createdAt,
    url: `http://127.0.0.1:${entry.port}/`, status: await this.status(entry),
  }))); }
  create(input: NewSession): Promise<string> { return this.serial(async () => {
    const value = newSessionSchema.parse(input);
    if (value.game === 'doom' && value.learning) throw new Error('Enable Doom learning from its gameplay settings');
    const used = new Set([...this.entries.map(entry => entry.port), Number(new URL(this.options.managerUrl).port)]);
    const port = await unusedPort(used);
    const entry: Entry = { ...value, id: randomUUID(), port, token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    await this.save([...this.entries, entry]);
    return entry.id;
  }); }
  rename(id: string, title: string): Promise<void> { return this.serial(async () => {
    const entry = this.entry(id), name = newSessionSchema.shape.title.parse(title);
    await this.save(this.entries.map(item => item === entry ? { ...entry, title: name } : item));
  }); }
  start(id: string): Promise<void> { return this.serial(async () => {
    const entry = this.entry(id), status = await this.status(entry);
    if (status === 'ready' || status === 'starting') return;
    if (status !== 'stopped') throw new Error('This session port is occupied or its owner cannot be verified. No process was replaced.');
    const directory = join(this.lease.directory, 'runs', entry.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.launching.set(id, Date.now());
    try { await (this.options.launch ?? launchGameHost)({ entry: { ...entry }, directory, managerUrl: this.options.managerUrl }); }
    catch (error) { this.launching.delete(id); throw error; }
  }); }
  stop(id: string): Promise<void> { return this.serial(async () => {
    const entry = this.entry(id), status = await this.status(entry);
    if (status === 'stopped' || status === 'stopping') return;
    if (status !== 'ready') throw new Error('Wait for the session to be ready before stopping its backend.');
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/session-control`, { method: 'POST', headers: { 'x-session-token': entry.token }, signal: AbortSignal.timeout(2000), redirect: 'error' });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error('The session did not accept a graceful stop');
  }); }
  private async status(entry: Entry): Promise<HostStatus> {
    try {
      const response = await fetch(`http://127.0.0.1:${entry.port}/api/session-control`, { headers: { 'x-session-token': entry.token }, signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return 'unavailable'; }
      const result = z.strictObject({ state: managedHostState, identity: z.string() }).safeParse(await response.json());
      if (!result.success || result.data.identity !== createHash('sha256').update(entry.token).digest('hex')) return 'unavailable';
      this.launching.delete(entry.id);
      return result.data.state;
    } catch (error) {
      // Only connection refusal establishes absence. Timeouts and invalid replies fail closed.
      if ((error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') return 'unavailable';
      const started = this.launching.get(entry.id);
      if (started && Date.now() - started < 10_000) return 'starting';
      this.launching.delete(entry.id);
      return 'stopped';
    }
  }
  async close() { this.closed = true; await this.operations; try { await this.store.flush(); } finally { await this.lease.release(); } }
}

async function unusedPort(used: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const socket = createServer();
    await new Promise<void>((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
    const address = socket.address();
    await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()));
    if (address && typeof address !== 'string' && !used.has(address.port)) return address.port;
  }
  throw new Error('Could not allocate a distinct session port');
}

/** Start only on explicit request. Direct Node launch avoids an orphaned npm wrapper. */
export async function launchGameHost({ entry, directory, managerUrl }: SessionLaunch): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, MOM_SESSION_MANAGER_URL: managerUrl, MOM_SESSION_TOKEN: entry.token,
    PORT: String(entry.port), MOM_DATA_DIR: directory, CHESS_PORT: String(entry.port), CHESS_DATA_DIR: directory,
    CHESS_MODEL: 'jev', CHESS_LEARNING: entry.learning ? '1' : '0', CHESS_ADOPT_LEARNING: '0' };
  const log = await open(join(directory, 'host.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx',
      entry.game === 'doom' ? 'examples/doom/server/src/main.ts' : 'examples/chess/web-server.ts'], {
      cwd: resolve('.'), env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((done, reject) => { child.once('error', reject); child.once('spawn', done); });
    child.unref();
  } finally { await log.close(); }
}
