import { executeLearningStage, canonicalJson, type BudgetLedger, type ExecutableProvider, type ExecutorLimits, type LearningRevision, type LearningStageRecord } from '@multiverse/gameplay-harness';
import type { ExecutableStore } from '@multiverse/gameplay-harness/node';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessPolicy } from './session-types.ts';
import { prepareChessRequest, type ChessDecisionRequest } from './preparation.ts';

type PreparationInput = ChessDecisionRequest & { learning: Pick<LearningRevision<ChessPolicy>, 'policy' | 'prompts' | 'skills'> };
/** Supervisor code prepares options in isolation; Jev still selects each move from the validated menu. */
export class ChessPreparedModel implements ChessDecisionModel {
  readonly version;
  private readonly revision: LearningRevision<ChessPolicy>;
  private readonly limits: ExecutorLimits;
  constructor(revision: LearningRevision<ChessPolicy>, private readonly options: {
    store: ExecutableStore; executor: ExecutableProvider; ledger: BudgetLedger; limits: ExecutorLimits;
    decision: ChessDecisionModel;
    record(value: LearningStageRecord<PreparationInput>): Promise<void>;
  }) {
    this.revision = structuredClone(revision); this.version = Object.freeze({ ...revision.model }); this.limits = { ...options.limits };
  }
  async prepare(request: ChessDecisionRequest, signal: AbortSignal): Promise<ChessDecisionRequest> {
    signal.throwIfAborted();
    if (canonicalJson(request.revision) !== canonicalJson(this.revision.revision)) throw new Error('Chess preparation revision mismatch');
    const input: PreparationInput = { ...structuredClone(request), learning: {
      policy: this.revision.policy, prompts: this.revision.prompts, skills: this.revision.skills,
    } };
    return executeLearningStage(input, {
      stage: 'chess-preparation', owner: this.revision.revision.version,
      artifact: await this.options.store.get(this.revision.executor), executor: this.options.executor,
      ledger: this.options.ledger, limits: this.limits, record: this.options.record,
      validate: (output, captured) => prepareChessRequest(output, {
        state: captured.state, objective: captured.objective, candidates: captured.candidates,
        experience: captured.experience, revision: captured.revision,
      }),
    }, signal);
  }
  async decide(request: ChessDecisionRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!request.strategy || canonicalJson(request.strategy.revision) !== canonicalJson(this.revision.revision)
      || canonicalJson(request.revision) !== canonicalJson(this.revision.revision)) throw new Error('Chess decision requires preparation for its active revision');
    return this.options.decision.decide(request, signal);
  }
}
