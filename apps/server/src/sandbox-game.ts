import type { Sandbox, ExecHandle, ExecSink } from 'microsandbox';
import type { GameState, Step } from '../../../packages/contracts/src/game.ts';

// This client process is disposable. The detached game process owns the actual
// WASM state. Close clients before capture, then open fresh ones in each child.
const relaySource = `
const readline = require('node:readline');
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const { id, path, data } = JSON.parse(line);
    try {
      const response = await fetch('http://127.0.0.1:8766' + path, {
        method: data ? 'POST' : 'GET', body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(await response.text());
      const body = Buffer.from(await response.arrayBuffer()).toString('base64');
      process.stdout.write(JSON.stringify({ id, body }) + '\\n');
    } catch (error) { process.stdout.write(JSON.stringify({ id, error: error.message }) + '\\n'); }
  }
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
`;
type Pending = { resolve: (value: Buffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Channel = { handle: ExecHandle; input: ExecSink; done: Promise<void>; pending: Map<number, Pending> };

export class SandboxGame {
  private channel?: Promise<Channel>;
  private sequence = 0;
  constructor(readonly sandbox: Sandbox) {}

  private async connect(): Promise<Channel> {
    const handle = await this.sandbox.execStreamWith('node', options => options.args(['-e', relaySource]).stdinPipe());
    const input = await handle.takeStdin();
    if (!input) { await handle.kill(); throw new Error('Game relay has no input pipe'); }
    const channel: Channel = { handle, input, done: Promise.resolve(), pending: new Map() };
    channel.done = this.read(channel);
    return channel;
  }
  private async read(channel: Channel) {
    let buffer = '';
    let failure = new Error('Game relay disconnected');
    try {
      for await (const event of channel.handle) {
        if (event.kind === 'stderr') failure = new Error(`Game relay: ${Buffer.from(event.data).toString().slice(0, 300)}`);
        if (event.kind !== 'stdout') continue;
        buffer += Buffer.from(event.data).toString();
        if (buffer.length > 4_000_000) throw new Error('Game relay response too large');
        let boundary;
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 1);
          const pending = channel.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer); channel.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`Game bridge: ${message.error}`));
          else if (typeof message.body !== 'string') pending.reject(new Error('Invalid game relay response'));
          else pending.resolve(Buffer.from(message.body, 'base64'));
        }
      }
    } catch (error) { failure = error instanceof Error ? error : failure; }
    finally {
      for (const pending of channel.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
      channel.pending.clear();
    }
  }
  async close(): Promise<void> {
    const opening = this.channel;
    this.channel = undefined;
    if (!opening) return;
    const channel = await opening;
    await channel.input.close();
    await channel.done;
  }
  async request(path: '/state' | '/frame' | '/step', data?: Step): Promise<Buffer> {
    this.channel ??= this.connect().catch(error => { this.channel = undefined; throw error; });
    const channel = await this.channel;
    const id = ++this.sequence;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { channel.pending.delete(id); reject(new Error('Game relay request timed out; action was not retried')); }, 15_000);
      channel.pending.set(id, { resolve, reject, timer });
      void channel.input.write(JSON.stringify({ id, path, data }) + '\n').catch(error => {
        clearTimeout(timer); channel.pending.delete(id); reject(error);
      });
    });
  }
  async state(): Promise<GameState> { return JSON.parse((await this.request('/state')).toString()); }
  async step(action: Step): Promise<GameState> { return JSON.parse((await this.request('/step', action)).toString()); }
  frame(): Promise<Buffer> { return this.request('/frame'); }
}
