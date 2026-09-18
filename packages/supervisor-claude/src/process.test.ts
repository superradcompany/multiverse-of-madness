import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBoundedProcess } from './process.ts';

const run = (source: string, timeoutMs = 1000, maxOutputBytes = 1024, signal = new AbortController().signal) => runBoundedProcess({
  executable: process.execPath, args: ['-e', source], input: '', cwd: tmpdir(), env: {}, timeoutMs, maxOutputBytes,
}, signal);

test('bounded supervisor processes return results and join timeout/output-limit cleanup', async () => {
  assert.equal((await run('process.stdout.write("done")')).stdout, 'done');
  const deadline = await run('setInterval(() => {}, 100)', 50); assert.equal(deadline.status, 'timeout');
  const flood = await run('process.stdout.write("x".repeat(20000)); setInterval(() => {}, 100)', 1000, 100);
  assert.equal(flood.status, 'failed'); assert.match(flood.error!, /output exceeds/); assert.ok(flood.stdout.length <= 100);
});

test('cancellation joins the process group', async () => {
  const control = new AbortController();
  const pending = run('setInterval(() => {}, 100)', 1000, 1024, control.signal); control.abort();
  assert.equal((await pending).status, 'cancelled');
});

for (const interruption of ['host-kill', 'group-term', 'group-int'] as const) test(`${interruption} cannot leave the model process running`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-watchdog-')), marker = join(root, 'pid');
  const module = new URL('./process.ts', import.meta.url).href;
  const source = `import {runBoundedProcess} from ${JSON.stringify(module)}; await runBoundedProcess({executable:process.execPath,args:['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 100)`)}],input:'',cwd:${JSON.stringify(root)},env:{},timeoutMs:10000,maxOutputBytes:100},new AbortController().signal);`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore', detached: true });
  const exited = new Promise<void>(resolve => host.once('close', () => resolve()));
  let pid = 0;
  try {
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(marker, 'utf8')); break; } catch { await sleep(10); } }
    assert.ok(pid > 0, 'model process started');
    if (interruption === 'host-kill') host.kill('SIGKILL');
    else process.kill(-host.pid!, interruption === 'group-term' ? 'SIGTERM' : 'SIGINT');
    await exited;
    let alive = true;
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await sleep(10); } catch { alive = false; break; } }
    assert.equal(alive, false, 'watchdog reaped the model after losing the host');
  } finally { host.kill('SIGKILL'); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await rm(root, { recursive: true, force: true }); }
});
