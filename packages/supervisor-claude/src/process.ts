import { fork } from 'node:child_process';
import type { BoundedProcessInput, BoundedProcessResult } from './process-types.ts';

/** POSIX provider primitive: joined process-group cancellation and an independent host-death watchdog. */
export async function runBoundedProcess(input: BoundedProcessInput, signal: AbortSignal): Promise<BoundedProcessResult> {
  if (process.platform === 'win32') throw new Error('Supervisor process isolation currently requires a POSIX host');
  if ((input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) || (input.maxOutputBytes !== undefined && (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1))) throw new Error('Invalid process bounds');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const guard = fork(new URL('./watchdog.ts', import.meta.url), { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result: BoundedProcessResult | undefined, failure: Error | undefined;
    const cancel = () => { if (guard.connected) guard.send({ cancel: true }, error => { if (error) failure = error; }); };
    signal.addEventListener('abort', cancel, { once: true });
    guard.once('error', error => { failure = error; });
    guard.once('message', value => { result = value as BoundedProcessResult; });
    guard.once('close', () => {
      signal.removeEventListener('abort', cancel);
      if (result) resolve(result); else reject(failure ?? new Error('Supervisor watchdog stopped without a result'));
    });
    guard.send(input, error => { if (error) { failure = error; if (guard.connected) guard.disconnect(); } });
    if (signal.aborted) cancel();
  });
}
