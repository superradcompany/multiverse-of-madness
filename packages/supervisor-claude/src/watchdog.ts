import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BoundedProcessInput, BoundedProcessResult } from './process-types.ts';

// A separate supervisor process owns the deadline and group cleanup even if the host exits.
let child: ChildProcessWithoutNullStreams | undefined, done = false, stopping: BoundedProcessResult['status'] | undefined;
let timer: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined;
let bytes = 0, exitError: string | undefined;
const stdout: Buffer[] = [], stderr: Buffer[] = [];
const startup = setTimeout(() => finish(null, 'No process request received'), 5000);
function killGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') exitError = 'Process group cleanup failed'; }
}
function stop(status: BoundedProcessResult['status']): void {
  stopping ??= status;
  if (!child) { finish(null); return; }
  killGroup('SIGTERM');
  escalation ??= setTimeout(() => killGroup('SIGKILL'), 250);
}
function finish(exitCode: number | null, error?: string): void {
  if (done) return; done = true; clearTimeout(startup); clearTimeout(timer); clearTimeout(escalation);
  killGroup('SIGKILL'); // Remove helpers even when the group leader completed normally.
  const result: BoundedProcessResult = { status: stopping ?? (exitCode === 0 && !error && !exitError ? 'complete' : 'failed'),
    stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), outputBytes: bytes, exitCode,
    ...(error || exitError ? { error: error ?? exitError } : {}) };
  if (process.connected) process.send?.(result, () => { if (process.connected) process.disconnect(); });
}
process.on('SIGTERM', () => { if (!done) stop('cancelled'); });
process.on('SIGINT', () => { if (!done) stop('cancelled'); });
process.on('disconnect', () => { if (!done) stop('cancelled'); });
process.on('message', (message: BoundedProcessInput | { cancel: true }) => {
  if ('cancel' in message) { stop('cancelled'); return; }
  if (child || done) return;
  clearTimeout(startup);
  if (message.timeoutMs !== undefined) timer = setTimeout(() => stop('timeout'), message.timeoutMs);
  try {
    child = spawn(message.executable, message.args, { cwd: message.cwd, env: message.env, detached: true, stdio: 'pipe' });
    child.once('error', () => { exitError = 'Process launch failed'; });
    child.once('close', code => finish(code));
    const receive = (chunks: Buffer[], buffer: Buffer) => {
      bytes += buffer.length;
      if (message.maxOutputBytes === undefined || bytes <= message.maxOutputBytes) chunks.push(buffer);
      else { exitError = 'Process output exceeds limit'; stop('failed'); }
    };
    child.stdout.on('data', buffer => receive(stdout, buffer)); child.stderr.on('data', buffer => receive(stderr, buffer));
    child.stdin.on('error', () => {}); child.stdin.end(message.input);
  } catch { finish(null, 'Process launch failed'); }
});
