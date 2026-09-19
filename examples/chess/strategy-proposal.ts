import type { ChessStrategyFeedback } from './evaluation-feedback.ts';
import type { ChessTrainingFeedback } from './training-feedback.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { canonicalJson, trainingMenu, validateTrainingSelection, validateExecutableSource, validateGameDescription, type TrainingCatalog, type TrainingMenu, type BudgetLedger, type ExecutableSource, type GameDescription, type LearningRevision, type ProposalOrigin, type SupervisorProvider, type VersionRef, type SupervisorLimits } from '@multiverse/gameplay-harness';
import { contentRevision, type ExecutableStore } from '@multiverse/gameplay-harness/node';
import { z } from 'zod';
import type { ChessPolicy } from './session-types.ts';
import type { ChessTemporaryGoal } from './temporary-goal.ts';
import type { ChessState } from './runtime.ts';

export interface ChessStrategyEvidence {
  game: GameDescription;
  currentSource: ExecutableSource;
  temporaryGoal?: ChessTemporaryGoal;
  review?: { reason: string; issue: string };
  recentEvaluations?: ChessStrategyFeedback[];
  training?: TrainingMenu;
  recentTraining?: ChessTrainingFeedback[];
  observations: Array<{ before: ChessState; selected: string; after: ChessState }>;
}
export const chessStrategyTask = `Create or improve a reusable TypeScript strategy from evidence.game, the host-authored description of this game. This code prepares useful alternatives and compact guidance; Jev, not this code, selects the action each turn. No hand-written opening repertoire is required. Use observations and recentEvaluations to address repeated mistakes and avoid repeating rejected hypotheses. Prefer a compact change to strategic guidance, labels or candidate selection. The host already supplies legal moves and Jev makes the frequent decisions; do not rebuild the chess rules engine or an opponent search engine without evidence that this is necessary. Empty observations means bootstrap from mechanics and objective, not demonstrated learning from results.
The default export receives {state, objective, candidates, experience, revision, learning:{policy,prompts,skills}}. Legal candidates have {id,label,payload:{san},expectedBenefit,...}. Return exactly {abi:"chess-preparation/1", guidance:string, plans:[{id:string,label:string,expectedBenefit:string}], experienceIndices:number[]}.
Select one or more distinct IDs from the current candidate pool; do not invent controls or move payloads. Keep genuinely different alternatives available when the situation is uncertain. The host preserves command payloads and validates legality. Labels max 120 characters, expectedBenefit max 400, guidance max 2000. Experience indices must refer to distinct entries of the supplied measured experience array. Do not invent history, scores or observations. Advice must respect the current objective; it is advisory, not a replacement objective. Opponent turns must remain competitive against the controlled player. Respect terminal status and avoid assumptions about the initial board.
Return a reason and complete ExecutableSource (format 1, runtime node-typescript, entrypoint and files). The source must be deterministic, self-contained Node TypeScript, with no installed dependencies, network, subprocesses or host imports. The host runs it in a networkless VM and independently measures outcomes. Do not activate it or change evaluators, histories or host artifacts. Report missing observations/control capabilities honestly.
When evidence.training offers practice positions, you may return optional training:{catalog:the exact catalog reference,scenarioIds:[IDs from that menu],reason:string}. Choose only positions that test a specific uncertainty, up to maximumSelection; omit training when practice adds no useful evidence. This chooses practice for this proposal, not acceptance tests, seeds, budgets or success criteria. The host compares both sources on the selected previously observed positions and feeds measured practice results into a later review. Use recentTraining to avoid repeating unchanged experiments. Practice cannot qualify a revision; independent host acceptance still runs separately. Never infer general strength or promotion from practice gains.
You may alternatively return abi="chess-preparation/2" with optional temporaryGoal:{key,instruction,reason,evidence:["current-state"],duration,target}. Key follows [a-z][a-zA-Z0-9_-]{0,63}; instruction/reason <=240 characters; duration 1..32 half-moves. Targets: {kind:"occupy",square:"a1".."h8",piece:"p"|"n"|"b"|"r"|"q"|"k"} for a controlled-side piece, {kind:"material",minimum:-39..39} for the controlled-side material advantage, {kind:"check"}, or {kind:"checkmate"}. Input temporaryGoal contains host frame/player and optional current record. Goals guide the controlled side only; the opponent remains competitive. Ground goals in the board and user objective. The host checks outcomes from engine state and owns scope, deadline and identity. Reuse a key for the same pursuit; repeated keys never renew deadlines or reactivate terminal goals. Inspect the current outcome before proposing a meaningfully different replacement. Omission retains existing guidance until it ends. Do not change identities or deadlines, encode acceptance scores, or pretend a material target proves a forced win.`;

/** Generate source data only. The caller owns the durable job, cancellation and later qualification/activation. */
export async function proposeChessStrategy(options: {
  id: string; origin: ProposalOrigin; current: LearningRevision<ChessPolicy>; objective: string;
  game: GameDescription; contract: VersionRef; temporaryGoal?: ChessTemporaryGoal; review?: { reason: string; issue: string }; recentEvaluations?: ChessStrategyFeedback[]; observations: ChessStrategyEvidence['observations'];
  training?: TrainingCatalog<ChessStrategyScenario>; recentTraining?: ChessTrainingFeedback[];
  provider: SupervisorProvider<ChessPolicy, ChessStrategyEvidence>; limits: SupervisorLimits; store: ExecutableStore; ledger: BudgetLedger;
}, signal: AbortSignal) {
  signal.throwIfAborted(); validateGameDescription(options.game);
  const captured = structuredClone({ id: options.id, origin: options.origin, current: options.current, objective: options.objective, game: options.game, contract: options.contract, observations: options.observations, ...(options.temporaryGoal ? { temporaryGoal: options.temporaryGoal } : {}), ...(options.review ? { review: options.review } : {}), ...(options.recentEvaluations ? { recentEvaluations: options.recentEvaluations } : {}) });
  const catalog = options.training && structuredClone(options.training), menu = catalog && trainingMenu(catalog);
  const recentTraining = options.recentTraining && structuredClone(options.recentTraining);
  if (canonicalJson(captured.current.adapter) !== canonicalJson(captured.game.adapter)
    || canonicalJson(captured.origin.activation.revision) !== canonicalJson(captured.current.revision)) throw new Error('Chess strategy origin does not match the active game revision');
  const source = (await options.store.get(captured.current.executor)).source;
  const output = await options.ledger.run({ owner: captured.id, operation: 'chess-strategy-proposal', reserve: { supervisorCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
    const result = await options.provider.propose({ id: captured.id, origin: captured.origin, current: captured.current,
      objective: captured.objective, capabilities: ['executor'], contract: captured.contract, task: chessStrategyTask,
      evidence: { game: captured.game, currentSource: source, observations: captured.observations, ...(captured.temporaryGoal ? { temporaryGoal: captured.temporaryGoal } : {}), ...(captured.review ? { review: captured.review } : {}), ...(captured.recentEvaluations ? { recentEvaluations: captured.recentEvaluations } : {}), ...(menu ? { training: menu } : {}), ...(recentTraining ? { recentTraining } : {}) },
      outputSchema: { type: 'object', additionalProperties: false, required: ['reason', 'source'], properties: {
        reason: { type: 'string', minLength: 1, maxLength: 4000 },
        ...(menu?.maximumSelection ? { training: { type: 'object', additionalProperties: false, required: ['catalog', 'scenarioIds', 'reason'], properties: {
          catalog: { const: menu.catalog }, scenarioIds: { type: 'array', minItems: 1, maxItems: menu.maximumSelection, uniqueItems: true, items: { enum: menu.scenarios.map(scenario => scenario.id) } }, reason: { type: 'string', minLength: 1, maxLength: 1000 },
        } } } : {}),
        source: { type: 'object', additionalProperties: false, required: ['format', 'runtime', 'entrypoint', 'files'], properties: {
          format: { const: 1 }, runtime: { const: 'node-typescript' }, entrypoint: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } },
        } },
      } },
    }, options.limits, signal);
    // The Codex CLI ignores legacy cutoffs; accounting is diagnostic and the supplied ledger can be uncapped.
    if (result.receipt.status !== 'complete') throw new Error('Chess strategy generation did not complete');
    return { value: result, usage: { supervisorCalls: 1, ...(result.receipt.usage ? { inputTokens: result.receipt.usage.inputTokens, outputTokens: result.receipt.usage.outputTokens } : {}) } };
  }, signal);
  signal.throwIfAborted();
  const draft = z.strictObject({ reason: z.string().trim().min(1).max(4000), source: z.unknown(), training: z.unknown().optional() }).parse(output.draft);
  if (draft.training !== undefined && !catalog) throw new Error('No host training catalog was offered');
  const training = draft.training === undefined ? undefined : validateTrainingSelection(catalog!, draft.training);
  const candidateSource = draft.source as ExecutableSource; validateExecutableSource(candidateSource);
  const executable = await options.store.put(candidateSource), { revision: _previous, ...fields } = captured.current;
  const data = { ...fields, executor: executable.revision };
  return { origin: captured.origin, artifact: { ...data, revision: contentRevision('chess-learning-system', data) }, reason: draft.reason, receipt: output.receipt, ...(training ? { training } : {}) };
}
