import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { executeLearningStage, type BudgetLedger, type ExecutableProvider, type ExecutorLimits, type LearningRevision } from '@multiverse/gameplay-harness';
import type { ExecutableStore } from '@multiverse/gameplay-harness/node';
import type { GameState } from '../../contracts/src/game.ts';
import { Jev, type Decision, type DecisionContext, type DecisionMaker } from './jev.ts';
import { jevGuidance } from './jev-learning.ts';
import { doomPreparationInput } from './doom-preparation-input.ts';
import { prepareDoomContext } from './doom-preparation.ts';
import type { DoomExecutorDecision } from './doom-executor-model.ts';
import type { Experience } from './experience.ts';
import type { DoomPolicy } from './doom-policy.ts';
import { proposeDoomTemporaryGoal } from './doom-temporary-goal.ts';

/** Isolated editable retrieval/context/planning followed by Jev; host still owns facts, motor execution and evaluation. */
export class DoomPreparedModel implements DecisionMaker {
  private readonly revision: LearningRevision<DoomPolicy>;
  private readonly limits: ExecutorLimits;
  private readonly jev: Jev;
  constructor(revision: LearningRevision<DoomPolicy>, private readonly options: {
    store: ExecutableStore; executor: ExecutableProvider; ledger: BudgetLedger; limits: ExecutorLimits;
    client?: Pick<TypeSafeClient, 'systemOne'>; record(decision: DoomExecutorDecision): Promise<void>;
  }) {
    this.revision = structuredClone(revision); this.limits = { ...options.limits };
    this.jev = new Jev('game-aware', options.client, { model: revision.model.version, guidance: jevGuidance(revision) });
  }
  async decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal,
    experience: Experience[] = [], actionTicks = 35, context: DecisionContext = {}): Promise<Decision> {
    signal.throwIfAborted();
    [state, history, experience, context] = structuredClone([state, history, experience, context]);
    const started = performance.now(), policy = context.policy ?? this.revision.policy;
    const input = await doomPreparationInput(this.revision, state, objective, history, experience, actionTicks, { ...context, policy });
    const prepared = await executeLearningStage(input, {
      stage: 'doom-preparation', owner: this.revision.revision.version, artifact: await this.options.store.get(this.revision.executor),
      executor: this.options.executor, ledger: this.options.ledger, limits: this.limits,
      record: record => this.options.record({ revision: this.revision, input: record.input, output: record.output, receipt: record.receipt }),
      validate: prepareDoomContext,
    }, signal);
    const temporaryGoal = proposeDoomTemporaryGoal(prepared.temporaryGoal, context.temporaryGoal, state);
    const decision = await this.options.ledger.run({ owner: this.revision.revision.version, operation: 'prepared-jev', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
      const value = await this.jev.decide(state, objective, prepared.history, signal, prepared.experience, actionTicks,
        { ...context, ...(context.temporaryGoal ? { temporaryGoal: { ...context.temporaryGoal, current: temporaryGoal } } : {}), prepared: { revision: this.revision.executor, plans: prepared.plans, features: prepared.features } });
      if (!value.usage) throw new Error('Prepared Jev decision did not report usage');
      return { value, usage: { modelCalls: 1, ...value.usage } };
    }, signal);
    return { ...decision, temporaryGoal, latencyMs: performance.now() - started,
      selectedExperience: prepared.experience.slice(0, decision.experienceUsed ?? 0),
      preparation: { revision: this.revision.executor, historyIndices: prepared.historyIndices,
        experienceIndices: prepared.experienceIndices.slice(0, decision.experienceUsed ?? 0), features: prepared.features,
        planIds: decision.plans?.candidates.map(plan => plan.id) ?? [] } };
  }
}
