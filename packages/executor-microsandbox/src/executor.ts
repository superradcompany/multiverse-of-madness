import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson, validateExecutorLimits, type ExecutableArtifact, type ExecutableProvider, type ExecutorLimits, type ExecutorOutput, type ExecutorReceipt, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, verifyExecutableArtifact } from '@multiverse/gameplay-harness/node';
import { Sandbox, SandboxNotFoundError, type CreationProgressCreate } from 'microsandbox';
import { executorRunner } from './runner.ts';
import { assertIsolatedConfig } from './isolation.ts';

export interface ExecutorRunRecord {
  id: string;
  identity?: string;
  revision: VersionRef;
  phase: 'creating' | 'running' | 'released' | 'cleanup-failed';
  receipt?: ExecutorReceipt;
  /** Host wall time, including failed phases. Diagnostic only; never a game score. */
  timings?: ExecutorTimings;
}
export interface ExecutorTimings {
  /** Provisioning, identity journaling and resolved isolation verification. */
  createMs: number;
  uploadMs: number;
  executeMs: number;
  /** Joined cancellation and authoritative VM destruction. */
  cleanupMs: number;
}
export class ExecutorFailure extends Error {
  constructor(message: string, readonly receipt: ExecutorReceipt, options?: ErrorOptions) { super(message, options); this.name = 'ExecutorFailure'; }
}

/** One isolated, networkless VM per invocation. Candidate code receives only explicit JSON input. */
export class MicrosandboxExecutor implements ExecutableProvider {
  readonly version: VersionRef;
  constructor(private readonly options: { image: string; record(record: ExecutorRunRecord): Promise<void> }) {
    if (!/@sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error('Executor image must be pinned to a manifest digest');
    this.options = { ...options };
    this.version = contentRevision('microsandbox-typescript-executor', { protocol: 1, runner: executorRunner, image: options.image, sdk: '0.7.1' });
  }

  async execute(artifact: ExecutableArtifact, input: unknown, limits: ExecutorLimits, signal: AbortSignal): Promise<ExecutorOutput> {
    verifyExecutableArtifact(artifact); validateExecutorLimits(limits);
    artifact = JSON.parse(canonicalJson(artifact)) as ExecutableArtifact;
    limits = { ...limits };
    const bytes = Buffer.from(canonicalJson(input));
    if (bytes.length > limits.maxInputBytes) throw new Error('Executor input exceeds size limit');
    signal.throwIfAborted();
    const id = `mom-executor-${randomUUID()}`;
    const receipt: ExecutorReceipt = { revision: artifact.revision, provider: this.version, limits: { ...limits }, runtime: { id, identity: '', image: this.options.image },
      startedAt: Date.now(), elapsedMs: 0, stdoutBytes: 0, stderrBytes: 0, status: 'failed' };
    let record: ExecutorRunRecord = { id, revision: artifact.revision, phase: 'creating' };
    await this.options.record(structuredClone(record));
    const started = performance.now(), control = new AbortController();
    const timings: ExecutorTimings = { createMs: 0, uploadMs: 0, executeMs: 0, cleanupMs: 0 };
    let phase: keyof ExecutorTimings = 'createMs', phaseStarted = started;
    const nextPhase = (next: keyof ExecutorTimings) => {
      const now = performance.now(); timings[phase] += now - phaseStarted; phase = next; phaseStarted = now;
    };
    let sandbox: Sandbox | undefined, creation: CreationProgressCreate | undefined;
    let stopping: Promise<void> | undefined, timedOut = false, failed = false, failure: unknown, value: unknown;
    const stop = (reason: unknown) => {
      if (!control.signal.aborted) control.abort(reason);
      creation?.cancel();
      if (sandbox && !stopping) stopping = sandbox.requestKill().catch(() => {}); // Exact-identity destroy below remains authoritative.
    };
    const cancelled = () => stop(signal.reason ?? new Error('Executor cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(new Error('Executor deadline exceeded')); }, limits.timeoutMs);
    if (signal.aborted) cancelled();
    try {
      control.signal.throwIfAborted();
      creation = await Sandbox.builder(id).image(this.options.image).detached(true).disableNetwork()
        .memory(limits.memoryMiB).maxMemory(limits.memoryMiB).cpus(limits.cpus).maxCpus(limits.cpus).rootDisk(256)
        .label('app', 'multiverse-executor').label('executor-run', id).label('executor-revision', artifact.revision.version)
        .createWithProgress();
      if (control.signal.aborted) creation.cancel();
      sandbox = await creation.awaitSandbox(); creation = undefined;
      receipt.runtime.identity = sandbox.id;
      record = { ...record, identity: sandbox.id, phase: 'running' };
      await this.options.record(structuredClone(record));
      control.signal.throwIfAborted();
      assertIsolatedConfig(await sandbox.config(), limits);
      nextPhase('uploadMs');
      await sandbox.fs().mkdir('/revision');
      for (const [path, source] of Object.entries(artifact.source.files)) {
        control.signal.throwIfAborted();
        const directory = posix.dirname(`/revision/${path}`);
        if (directory !== '/revision') await sandbox.fs().mkdir(directory);
        await sandbox.fs().write(`/revision/${path}`, source);
      }
      await sandbox.fs().write('/executor-runner.mjs', executorRunner);
      control.signal.throwIfAborted();
      const remaining = Math.max(1, Math.ceil(limits.timeoutMs - (performance.now() - started)));
      nextPhase('executeMs');
      const exec = await sandbox.execStreamWith('env', options => options.args(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'node',
        '--disable-warning=ExperimentalWarning', '/executor-runner.mjs', artifact.source.entrypoint])
        .user('1000:1000').timeout(remaining).stdinBytes(bytes));
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let exitCode: number | undefined;
      for await (const event of exec) {
        if (event.kind === 'exited') { exitCode = event.code; continue; }
        if (event.kind !== 'stdout' && event.kind !== 'stderr') continue;
        const count = event.kind === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
        receipt[count] += event.data.byteLength;
        if (receipt.stdoutBytes + receipt.stderrBytes > limits.maxOutputBytes) { stop(new Error('Executor output exceeds size limit')); continue; }
        (event.kind === 'stdout' ? stdout : stderr).push(Buffer.from(event.data));
      }
      control.signal.throwIfAborted();
      if (exitCode === undefined) throw new Error('Executor stream closed without an exit status');
      if (exitCode !== 0) throw new Error(`Executor exited with code ${exitCode}: ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`);
      value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
      canonicalJson(value); // Refuse lossy/nonfinite JSON, even when a guest bypasses the runner.
      receipt.status = 'complete';
    } catch (error) {
      failed = true; failure = control.signal.aborted ? control.signal.reason : error;
      receipt.status = timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'failed';
      receipt.error = failure instanceof Error ? failure.message : 'Executor failed';
    } finally {
      nextPhase('cleanupMs');
      clearTimeout(timer); signal.removeEventListener('abort', cancelled);
      await stopping;
      try {
        // A failed creation may still have published its runtime; reconcile only this recorded invocation.
        await this.cleanup(record);
        record = { ...record, phase: 'released' };
      } catch (error) {
        failed = true; failure = new AggregateError([...(failure === undefined ? [] : [failure]), error], 'Executor cleanup failed');
        receipt.status = 'failed'; receipt.error = 'Executor cleanup failed'; record = { ...record, phase: 'cleanup-failed' };
      }
      receipt.elapsedMs = Math.ceil(performance.now() - started);
      nextPhase('cleanupMs');
      await this.options.record({ ...record, receipt: structuredClone(receipt), timings });
    }
    if (failed) throw new ExecutorFailure(receipt.error!, receipt, { cause: failure });
    return { value, receipt };
  }

  /** Reconcile after a host restart with exclusive journal ownership. Never reruns work or deletes a same-name replacement. */
  async recover(record: ExecutorRunRecord): Promise<void> {
    record = structuredClone(record);
    if (record.phase === 'released') return;
    await this.cleanup(record);
    await this.options.record({ ...record, phase: 'released' });
  }
  private async cleanup(record: ExecutorRunRecord): Promise<void> {
    if (!/^mom-executor-[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid executor cleanup identity');
    try {
      const handle = await Sandbox.get(record.id);
      if (record.identity && handle.id !== record.identity) throw new Error('Executor sandbox was replaced; refusing cleanup');
      const config = handle.config();
      const labels = config.labels as Record<string, string> | undefined;
      if (labels?.['executor-run'] !== record.id || labels?.['executor-revision'] !== record.revision.version || labels?.app !== 'multiverse-executor') throw new Error('Executor ownership labels do not match');
      await handle.destroy({ force: true, timeoutMs: 10_000 });
    } catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error; }
  }
}
