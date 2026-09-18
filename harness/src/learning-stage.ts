import { BudgetLedger } from './budget.ts';
import { canonicalJson } from './policy.ts';
import { validateExecutorLimits, type ExecutableArtifact, type ExecutableProvider, type ExecutorLimits, type ExecutorReceipt } from './executable.ts';

/** Durable raw evidence from one isolated, supervisor-editable stage. Validation is host-owned. */
export interface LearningStageRecord<Input> {
  stage: string;
  artifact: ExecutableArtifact['revision'];
  input: Input;
  output: unknown;
  receipt: ExecutorReceipt;
}
export interface LearningStageOptions<Input, Output> {
  stage: string;
  owner: string;
  artifact: ExecutableArtifact;
  executor: ExecutableProvider;
  ledger: BudgetLedger;
  limits: ExecutorLimits;
  record(value: LearningStageRecord<Input>): Promise<void>;
  /** Interpret untrusted output without executing candidate code in the host. */
  validate(value: unknown, input: Input): Output;
}

/** Composable preparation, retrieval or planning stage; no game/provider/filesystem assumptions. */
export async function executeLearningStage<Input, Output>(input: Input, options: LearningStageOptions<Input, Output>, signal: AbortSignal): Promise<Output> {
  signal.throwIfAborted();
  canonicalJson(input); validateExecutorLimits(options.limits);
  const captured = structuredClone(input), artifact = structuredClone(options.artifact), limits = structuredClone(options.limits);
  const executed = await options.ledger.run({ owner: options.owner, operation: options.stage, reserve: { executorCalls: 1 }, observe: ['executorWallMs'] }, async () => {
    const result = await options.executor.execute(structuredClone(artifact), structuredClone(captured), structuredClone(limits), signal);
    canonicalJson(result.value);
    await options.record({ stage: options.stage, artifact: artifact.revision, input: structuredClone(captured), output: structuredClone(result.value), receipt: structuredClone(result.receipt) });
    if (!Number.isFinite(result.receipt.elapsedMs) || result.receipt.elapsedMs < 0) throw new Error('Invalid learning-stage execution time');
    return { value: result, usage: { executorCalls: 1, executorWallMs: result.receipt.elapsedMs } };
  }, signal);
  signal.throwIfAborted();
  if (executed.receipt.status !== 'complete' || canonicalJson(executed.receipt.revision) !== canonicalJson(artifact.revision)
    || canonicalJson(executed.receipt.provider) !== canonicalJson(options.executor.version) || canonicalJson(executed.receipt.limits) !== canonicalJson(limits)) {
    throw new Error('Learning-stage receipt does not match the admitted execution');
  }
  return options.validate(structuredClone(executed.value), structuredClone(captured));
}
