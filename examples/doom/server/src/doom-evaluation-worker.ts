import '../../../../scripts/runtime-env.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setPriority } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { BudgetLedger } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../../../packages/executor-microsandbox/src/executor.ts';
import { decodeDoomLearningManifest } from './doom-learning-manifest.ts';
import { DoomVmEvaluations } from './doom-vm-evaluations.ts';
import { microsandboxEvaluationVmPorts } from './doom-evaluation-vm-provider.ts';
import { DoomLearningModels } from './doom-learning-models.ts';
import { DoomPreparedModel } from './doom-prepared-model.ts';
import { DoomExecutableModel } from './doom-executor-model.ts';
import { doomSurvivalProgress } from './doom-revision-evaluation.ts';
import type { EvaluationProcessCommand, EvaluationProcessReply } from './doom-evaluation-process.ts';

if (!process.send || !process.argv[2]) throw new Error('Background evaluator requires its owning server');
// Give interactive gameplay priority under CPU contention; sandbox children inherit this priority.
setPriority(10);
const directory = process.argv[2];
const manifest = decodeDoomLearningManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
const store = new JsonFileStore<ExecutorRunRecord[]>(join(directory, 'evaluation-executor-runs.json'), value => {
  if (!Array.isArray(value)) throw new Error('Invalid evaluation executor journal'); return value;
});
const records = new Map((await store.load() ?? []).map(record => [record.id, record]));
const executor = new MicrosandboxExecutor({ image: manifest.image, record: async record => {
  records.set(record.id, structuredClone(record)); await store.save([...records.values()]);
} });
const executables = new ExecutableStore(join(directory, 'executables'));
const registry = (ledger: BudgetLedger) => new DoomLearningModels({
  adapter: { id: 'doom-learning-adapter', version: manifest.build.revision.version },
  builtinExecutor: { id: 'doom-jev-host', version: manifest.build.revision.version }, profile: manifest.profile, executables,
  executable: artifact => {
    const options = { ledger, store: executables, executor, limits: manifest.executorLimits,
      record: (value: unknown) => new JsonFileStore(join(directory, 'executor-decisions', randomUUID() + '.json'), input => input).save(value) };
    return artifact.model.id === 'prepared-doom-jev' ? new DoomPreparedModel(artifact, options) : new DoomExecutableModel(artifact, options);
  },
});
let context: Extract<EvaluationProcessCommand, { kind: 'qualify' }>['context'] | undefined;
const evaluator = new DoomVmEvaluations({ directory: join(directory, 'evaluations'), contract: manifest.contract,
  runtime: microsandboxEvaluationVmPorts(manifest), models: registry, measure: doomSurvivalProgress,
  context: () => { if (!context) throw new Error('Missing frozen evaluation context'); return context; },
});
const recover = async () => {
  await evaluator.recover();
  for (const record of records.values()) if (record.phase !== 'released') await executor.recover(record);
  await store.flush();
};
let active: { id: number; control: AbortController } | undefined;
let work = Promise.resolve();
const reply = (message: EvaluationProcessReply | { ready: true }) => { if (process.connected) process.send?.(message, () => {}); };
process.on('message', (command: EvaluationProcessCommand | { id: number; kind: 'cancel' }) => {
  if (command.kind === 'cancel') { if (active?.id === command.id) active.control.abort(new Error('Evaluation cancelled')); return; }
  if (active) { reply({ id: command.id, error: 'Background evaluator is busy' } satisfies EvaluationProcessReply); return; }
  const control = new AbortController(); active = { id: command.id, control };
  work = (async () => {
    try {
      if (command.kind === 'recover') { await recover(); reply({ id: command.id } satisfies EvaluationProcessReply); }
      else {
        context = command.context;
        const result = await evaluator.qualify(command.request, control.signal, command.incident, command.continuation);
        reply({ id: command.id, result } satisfies EvaluationProcessReply);
      }
    } catch (error) { reply({ id: command.id, error: error instanceof Error ? error.message : String(error) } satisfies EvaluationProcessReply); }
    finally { active = undefined; }
  })();
});
process.on('disconnect', () => {
  active?.control.abort(new Error('Owning gameplay server disconnected'));
  void work.finally(async () => { await recover(); process.exit(0); }).catch(() => process.exit(1));
});
if (!process.connected) { await recover(); process.exit(1); }
reply({ ready: true });
