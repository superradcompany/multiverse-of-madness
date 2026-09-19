import type { DoomVmScenario } from './doom-vm-evaluations.ts';
import type { TrainingCatalog, TrainingSelection } from '@multiverse/gameplay-harness';
import type { SessionContinuation } from './session.ts';
import type { DoomIncidentCheckpoint } from './doom-evaluation-vms.ts';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { Qualification, QualificationRequest, VersionRef } from '@multiverse/gameplay-harness';
import type { DoomPolicy } from './doom-policy.ts';
import type { DoomEvaluationContext } from './doom-revision-evaluation.ts';
import type { DoomLearningManifest } from './doom-learning-manifest.ts';

export type EvaluationProcessCommand = { id: number; kind: 'recover' } | {
  id: number; kind: 'qualify'; request: QualificationRequest<DoomPolicy>;
  context: { revision: VersionRef; value: DoomEvaluationContext };
  incident?: DoomIncidentCheckpoint; continuation?: SessionContinuation; training?: TrainingSelection; trainingCatalog?: TrainingCatalog<DoomVmScenario>;
};
export type EvaluationProcessReply = { id: number; result?: Qualification; error?: string };

/** Independent event loop and executor journal for background comparisons. */
export class DoomEvaluationProcess {
  readonly version: VersionRef;
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: Qualification | undefined): void; reject(error: Error): void }>();
  constructor(private readonly directory: string, manifest: DoomLearningManifest,
    private readonly context: () => { revision: VersionRef; value: DoomEvaluationContext }) {
    this.version = contentRevision('doom-evaluation-contract', manifest.contract);
  }
  async recover(): Promise<void> { await this.send({ id: ++this.sequence, kind: 'recover' }); }
  async qualify(request: QualificationRequest<DoomPolicy>, signal: AbortSignal, incident?: DoomIncidentCheckpoint, continuation?: SessionContinuation, training?: TrainingSelection, trainingCatalog?: TrainingCatalog<DoomVmScenario>): Promise<Qualification> {
    signal.throwIfAborted();
    const id = ++this.sequence;
    const cancel = () => { void this.ready?.then(() => { if (this.child?.connected) this.child.send({ kind: 'cancel', id }); }).catch(() => {}); };
    const command: EvaluationProcessCommand = structuredClone({ id, kind: 'qualify', request, context: this.context(),
      ...(training ? { training, trainingCatalog } : {}), ...(incident ? { incident, continuation } : {}) });
    const result = this.send(command);
    signal.addEventListener('abort', cancel, { once: true });
    try { return (await result)!; }
    finally { signal.removeEventListener('abort', cancel); }
  }
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.pending.size) throw new Error('Join background evaluations before closing their worker');
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.disconnect(); });
  }
  private send(command: EvaluationProcessCommand): Promise<Qualification | undefined> {
    if (!this.child) {
      const child = fork(fileURLToPath(new URL('./doom-evaluation-worker.ts', import.meta.url)), [this.directory], {
        execArgv: ['--import', 'tsx'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      this.child = child;
      let ready!: () => void, failed!: (error: Error) => void;
      this.ready = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
      child.on('message', (reply: EvaluationProcessReply | { ready: true }) => {
        if ('ready' in reply) { ready(); return; }
        const waiting = this.pending.get(reply.id); if (!waiting) return;
        this.pending.delete(reply.id);
        if (reply.error) waiting.reject(new Error(reply.error)); else waiting.resolve(reply.result);
      });
      const fail = (error: Error) => { failed(error); for (const waiting of this.pending.values()) waiting.reject(error); this.pending.clear(); };
      child.on('error', fail);
      child.on('exit', (code, signal) => { if (this.child === child) this.child = undefined; fail(new Error(`Background evaluator exited (${signal ?? code})`)); });
    }
    return new Promise((resolve, reject) => {
      this.pending.set(command.id, { resolve, reject });
      void this.ready!.then(() => this.child!.send(command, error => { if (error) { this.pending.delete(command.id); reject(error); } }))
        .catch(error => { this.pending.delete(command.id); reject(error); });
    });
  }
}
