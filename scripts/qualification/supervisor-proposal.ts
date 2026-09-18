import { join } from 'node:path';
import { z } from 'zod';
import { BudgetLedger, validateGameDescription, canonicalJson, validateExecutableSource, type GameDescription, type SupervisorProvider, type ExecutableSource, type LearningRevision, type ProposalOrigin, type RevisionController, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { ClaudeCodeSupervisor, SupervisorFailure } from '../../packages/supervisor-claude/src/provider.ts';
import type { ChessPolicy } from '../../examples/chess/session-types.ts';
import type { ChessState } from '../../examples/chess/runtime.ts';

export interface TrainingObservation { before: ChessState; selected: string; after: ChessState }
export interface ChessTrainingEvidence { game: GameDescription; currentSource: ExecutableSource; observations: TrainingObservation[] }
/** One measured generation attempt. Acceptance data and the live controller never enter the provider. */
export async function generateChessRevision(options: {
  directory: string;
  controller: Pick<RevisionController<ChessPolicy>, 'active' | 'current'>;
  provider?: SupervisorProvider<ChessPolicy, ChessTrainingEvidence>;
  context: VersionRef;
  contract: VersionRef;
  store: ExecutableStore;
  observations: TrainingObservation[];
  game: GameDescription;
}, signal: AbortSignal): Promise<{ artifact: LearningRevision<ChessPolicy>; origin: ProposalOrigin; reason: string }> {
  const origin = { activation: options.controller.active, context: options.context }, current = options.controller.current;
  validateGameDescription(options.game);
  if (canonicalJson(options.game.adapter) !== canonicalJson(current.adapter)) throw new Error('Supervisor game description does not match the active adapter');
  const source = (await options.store.get(current.executor)).source;
  const record = new JsonFileStore(join(options.directory, 'generation.json'), value => value);
  const provider = options.provider ?? await ClaudeCodeSupervisor.open<ChessPolicy, ChessTrainingEvidence>({ effort: 'medium', record: value => record.save(value) });
  const budgetStore = new JsonFileStore(join(options.directory, 'generation-budget.json'), value => value);
  // A generation process may include provider-internal requests: count invocations separately from API calls.
  const limits = { timeoutMs: 300_000, maxInputBytes: 65_536, maxOutputBytes: 65_536, maxCostMicros: 2_000_000 };
  const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: { supervisorCalls: 1, costMicros: limits.maxCostMicros } }, value => budgetStore.save(value));
  const generated = await ledger.run({ owner: 'supervisor', operation: 'source-proposal', reserve: { supervisorCalls: 1, costMicros: limits.maxCostMicros }, observe: ['inputTokens', 'outputTokens'] }, async () => {
    let output: Awaited<ReturnType<typeof provider.propose>> | undefined, failure: unknown;
    try {
      output = await provider.propose({ id: 'source-proposal', origin, current, objective: 'win by checkmate', capabilities: ['executor'], contract: options.contract,
        task: 'Improve the current TypeScript move-selector from the supplied observed failures. evidence.game is the host-authored description of observations, legal controls, timing, plan execution, outcomes and runtime limitations. Use only those available observations and controls; report missing capabilities in your reason rather than inventing them. The host will independently compare it on different, undisclosed starting positions using the same one-input budget. Return a reason and complete ExecutableSource. The default export receives {state:{fen,turn,ply,legalMoves,moves,status}, objective, candidates:[{id,payload:{san},label,...}], experience, revision, learning:{policy,prompts,skills}}. Return exactly {selected:string, confidence:number, preferences:[{id:string,probability:number}]}. Include every provided candidate exactly once; probabilities must sum to 1 and all numbers be finite in [0,1]. Select an available candidate ID. The host measures actual game outcomes, so return no score. Source must be deterministic TypeScript runnable by Node without imports, installed dependencies or external services. Propose source data only; do not change the game, objective, evaluator, limits or artifacts outside the returned source.',
        evidence: { game: options.game, currentSource: source, observations: options.observations }, outputSchema: {
          type: 'object', additionalProperties: false, required: ['reason', 'source'], properties: {
            reason: { type: 'string', minLength: 1, maxLength: 4000 }, source: { type: 'object', additionalProperties: false, required: ['format', 'runtime', 'entrypoint', 'files'], properties: {
              format: { const: 1 }, runtime: { const: 'node-typescript' }, entrypoint: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } },
            } },
          },
        },
      }, limits, signal);
    } catch (error) { failure = error; }
    const receipt = output?.receipt ?? (failure instanceof SupervisorFailure ? failure.receipt : undefined), usage = receipt?.usage;
    return { value: { output, failure }, usage: { supervisorCalls: 1, costMicros: usage?.costMicros ?? limits.maxCostMicros,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) } };
  }, signal);
  await ledger.join();
  if (generated.failure) throw generated.failure;
  const draft = z.strictObject({ reason: z.string().trim().min(1).max(4000), source: z.unknown() }).parse(generated.output!.draft);
  const candidateSource = draft.source as ExecutableSource; validateExecutableSource(candidateSource);
  const executable = await options.store.put(candidateSource), { revision: _previous, ...fields } = current;
  const data = { ...fields, executor: executable.revision }, artifact = { ...data, revision: contentRevision('chess-learning-system', data) };
  await new JsonFileStore(join(options.directory, 'generated-artifact.json'), value => value).save({ origin, artifact, reason: draft.reason });
  return { artifact, origin, reason: draft.reason };
}
