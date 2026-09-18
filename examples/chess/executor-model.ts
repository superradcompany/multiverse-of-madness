import { z } from 'zod';
import { BudgetLedger, type DecisionRequest, type ExecutableProvider, type ExecutorLimits, type ExecutorReceipt, type LearningRevision, type RankedChoice } from '@multiverse/gameplay-harness';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import type { ChessExperience, ChessPlan } from './adapter.ts';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessState } from './runtime.ts';
import type { ChessPolicy } from './session-types.ts';

type Request = DecisionRequest<ChessState, ChessPlan, ChessExperience>;
const probability = z.number().min(0).max(1);
const answer = z.strictObject({ selected: z.string(), confidence: probability, preferences: z.array(z.strictObject({ id: z.string(), probability })) });
export interface ChessExecutorDecision { request: Request; revision: LearningRevision<ChessPolicy>; receipt: ExecutorReceipt; output: unknown }

/** Untrusted learning code runs through the isolated provider; the host owns legal moves and usage. */
export class ChessExecutableModel implements ChessDecisionModel {
  readonly version;
  private readonly revision: LearningRevision<ChessPolicy>;
  private readonly limits: ExecutorLimits;
  constructor(revision: LearningRevision<ChessPolicy>, private readonly options: {
    store: ExecutableStore;
    executor: ExecutableProvider;
    ledger: BudgetLedger;
    limits: ExecutorLimits;
    record(decision: ChessExecutorDecision): Promise<void>;
  }) {
    this.revision = structuredClone(revision); this.version = Object.freeze({ ...revision.model }); this.limits = { ...options.limits };
  }
  async decide(request: Request, signal: AbortSignal): Promise<RankedChoice> {
    const captured = structuredClone(request), revision = this.revision;
    if (captured.revision.id !== revision.revision.id || captured.revision.version !== revision.revision.version) throw new Error('Executable decision revision mismatch');
    const result = await this.options.ledger.run({ owner: revision.revision.version, operation: 'chess-learning-executor', reserve: { executorCalls: 1 }, observe: ['executorWallMs'] }, async () => {
      const executed = await this.options.executor.execute(await this.options.store.get(revision.executor), {
        ...captured, learning: { policy: revision.policy, prompts: revision.prompts, skills: revision.skills },
      }, this.limits, signal);
      await this.options.record({ request: captured, revision: structuredClone(revision), receipt: executed.receipt, output: executed.value });
      return { value: executed.value, usage: { executorCalls: 1, executorWallMs: executed.receipt.elapsedMs } };
    }, signal);
    const selected = answer.parse(result), ids = new Set(captured.candidates.map(plan => plan.id));
    if (!ids.has(selected.selected) || selected.preferences.length !== ids.size || new Set(selected.preferences.map(preference => preference.id)).size !== ids.size
      || selected.preferences.some(preference => !ids.has(preference.id)) || Math.abs(selected.preferences.reduce((sum, preference) => sum + preference.probability, 0) - 1) > .000001) throw new Error('Executor returned an invalid chess decision');
    return { ...selected, usage: { calls: 0 } };
  }
}
