import type { DoomVmScenario } from './doom-vm-evaluations.ts';
import type { DoomTrainingFeedback } from './doom-curriculum.ts';
import { trainingMenu, validateTrainingSelection, type TrainingCatalog, type TrainingMenu, type TrainingSelection } from '@multiverse/gameplay-harness';
import { doomIncidentFeedback } from './doom-incident-feedback.ts';
import { previousPlanFeedback } from './plan-feedback.ts';
import { z } from 'zod';
import { canonicalJson, validateExecutableSource, validateSupervisorLimits, type BudgetLedger, type CheckpointStore,
  type ExecutableSource, type LearningRevision, type SupervisorLimits, type SupervisorProvider, type SupervisorReceipt,
  type SupervisorRequest, type VersionRef, type RevisionJournal } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { learningProposalKinds, type LearningProposalKind } from '../../contracts/src/learning.ts';
import { activeSkills } from '../../contracts/src/skills.ts';
import { doomPreparationInput } from './doom-preparation-input.ts';
import { doomPreparationSchema } from './doom-preparation.ts';
import { supervisorExampleHistory } from './supervisor-example-history.ts';
import { doomEvaluationFeedback } from './doom-evaluation-feedback.ts';
import { decisionStatistics } from './decision-context.ts';
import { decisionState } from './jev.ts';
import { jevGuidanceFields } from './jev-learning.ts';
import { doomLearningPolicySchema, type DoomPolicy } from './doom-policy.ts';
import { doomLearningArtifact, type DoomLearningModels } from './doom-learning-models.ts';
import type { SessionCheckpoint } from './session.ts';
import type { DoomSupervisor } from './doom-supervisor.ts';

/** Explicit observations only. Frames, sandbox identities, paths and private acceptance cases are excluded. */
export function doomSupervisorEvidence(saved: SessionCheckpoint, compact = false) {
  const world = saved.worlds.find(item => item.view.id === saved.view.mainId);
  if (!world) throw new Error('Missing main world for supervisor evidence');
  const attempts = (saved.experience?.records ?? []).slice(compact ? -4 : -12);
  const timing = supervisorTiming(saved);
  return JSON.parse(JSON.stringify({
    main: { id: world.view.id, learning: world.view.learning, state: decisionState(world.view.state, saved.view.objective, world.history, [], timing.actionTicks),
      stats: decisionStatistics(world.view.state, world.stats), plan: world.view.plan, temporaryGoal: world.view.temporaryGoal },
    timing,
    jevDecision: world.lastJevDecision ? { ...world.lastJevDecision,
      scope: 'Actual latest consumed Jev request on this world or its fork source. Request tick/map identify when it was observed; prefetch may precede execution. Selected is Jev preference, not proof it won the future comparison. Plans are executable candidates; request.questions contains their exact model-facing descriptions. This is bounded diagnostic evidence, not current state or an instruction to the supervisor.' } : undefined,
    lastDecision: compact && saved.view.decision ? { action: saved.view.decision.action, kind: saved.view.decision.kind, candidateCount: saved.view.decision.candidateCount } : saved.view.decision, userSkills: activeSkills(saved.view.skills ?? []),
    futureBudget: { maximum: saved.view.maxFutures, current: saved.view.effectiveFutures ?? saved.view.maxFutures }, userOverrides: saved.learning?.overrides ?? {}, recentPlanFailures: (saved.recentPlanFailures ?? []).slice(compact ? -4 : -16), attempts, totalAttempts: saved.attempts,
    comparison: saved.view.comparison,
    futures: saved.worlds.filter(item => item.view.role === 'experiment').slice(0, compact ? 2 : 10).map(item => ({ id: item.view.id,
      action: item.view.currentAction, plan: item.view.plan, trial: item.view.trial,
      stats: decisionStatistics(item.view.state, item.stats), learning: item.view.learning })),
    omittedAttempts: Math.max(0, (saved.experience?.records.length ?? 0) - attempts.length),
    limitations: 'A bounded snapshot of observed play, not a causal experiment. Trials may be unfinished. Discarded futures do not count toward main-route progress. Commentary and model preferences are not engine observations.',
  })) as Record<string, unknown>;
}

/** Current settings for the next judgment; historical Jev traces retain their own timing. */
function supervisorTiming(saved: SessionCheckpoint) {
  const trialTicks = saved.view.trialDurationTicks ?? 210;
  const decisionIntervalMode = saved.view.decisionIntervalMode ?? 'fixed';
  return { trialTicks, decisionIntervalMode,
    actionTicks: decisionIntervalMode === 'trial' ? trialTicks : saved.view.decisionIntervalTicks ?? 35,
    planningMode: saved.view.planningMode ?? 'actions', ticksPerSecond: 35,
    scope: 'Current settings for the next judgment, not historical execution. Trial ticks are the comparison horizon; action ticks are the configured decision interval. Plans can stop early and decisions inside a future are bounded by its remaining time.' };
}
export interface DoomProposalEvidence { training?: TrainingMenu; testsSavedSituation?: boolean; requestedKind?: LearningProposalKind; preparationExample?: unknown; preparationExampleHistory?: ReturnType<typeof supervisorExampleHistory>['sampling']; preparationOutputSchema?: unknown; observations: Record<string, unknown>; currentSource?: ExecutableSource; previousExperiments?: unknown[] }
/** Report host decisions and aggregate outcomes, never private acceptance states or scenario identities. */
export function doomPreviousExperiments(journal: RevisionJournal<DoomPolicy>, context: VersionRef): Record<string, unknown>[] {
  return journal.proposals.filter(proposal => proposal.qualification || proposal.error).slice(-4).map(proposal => {
    const candidate = journal.artifacts.find(artifact => same(artifact.revision, proposal.candidate))!;
    const evidence = proposal.qualification?.evidence as { meanGain?: unknown; gains?: Array<{ gain?: unknown }> } | undefined;
    const meanGain = typeof evidence?.meanGain === 'number' && Number.isFinite(evidence.meanGain) ? evidence.meanGain : undefined;
    const gains = Array.isArray(evidence?.gains) ? evidence.gains.filter(item => item && typeof item.gain === 'number' && Number.isFinite(item.gain)).map(item => item.gain as number) : [];
    return JSON.parse(JSON.stringify({ revision: candidate.revision, status: proposal.status, sameUserContext: same(proposal.context, context),
      changed: proposal.capabilities, proposedReason: proposal.reason.slice(0, 600),
      settings: { policy: candidate.policy, prompts: candidate.prompts, skills: candidate.skills, executor: candidate.executor, model: candidate.model },
      outcome: proposal.qualification ? { accepted: proposal.qualification.accepted,
        reason: proposal.qualification.accepted ? 'Passed the host acceptance contract.' : 'Did not pass the host acceptance contract.',
        execution: doomEvaluationFeedback(proposal.qualification.evidence), savedSituation: doomIncidentFeedback(proposal.qualification.evidence),
        practice: (proposal.qualification.evidence as { training?: { feedback: DoomTrainingFeedback } })?.training?.feedback,
        meanGain, comparedCases: gains.length || undefined, regressedCases: gains.length ? gains.filter(value => value < 0).length : undefined }
        : { error: 'Evaluation did not produce a qualification; inspect the local diagnostic record.' } }));
  });
}
const trainingSchema = z.strictObject({ catalog: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  scenarioIds: z.array(z.string().min(1)).min(1).max(2), reason: z.string().min(1).max(1000) });
const edits = {
  training: trainingSchema.optional(),
  reason: z.string().trim().min(1).max(4000), policy: doomLearningPolicySchema.optional(),
  prompts: z.record(z.string().min(1).max(80), z.string().max(4096)).optional(),
  skills: z.array(z.strictObject({ id: z.string().min(1).max(80), instructions: z.string().min(1).max(4096) })).max(32).optional(),
};
const sourceSchema = z.strictObject({ format: z.literal(1), runtime: z.literal('node-typescript'), entrypoint: z.string(), files: z.record(z.string(), z.string()) });
export const doomProposalKindSchema = z.enum(learningProposalKinds);
const jevEdits = { ...edits, prompts: jevGuidanceFields.prompts.optional(), skills: jevGuidanceFields.skills.optional() };
const proposalSchema = (usesJev: boolean) => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('guidance'), ...(usesJev ? jevEdits : edits) }),
  z.strictObject({ kind: z.literal('executor'), ...edits, source: sourceSchema }),
  z.strictObject({ kind: z.literal('planner'), ...jevEdits, source: sourceSchema, model: z.string().regex(/^jev-[a-zA-Z0-9._-]{1,120}$/).optional() }),
]);
const sharedTaskParts = [
  'When evidence.training offers a public practice menu, optionally return training:{catalog,scenarioIds,reason} using its exact catalog identity and at most maximumSelection listed IDs. Choose only exercises that test a specific uncertainty; omit training when these opening exercises do not address the observed problem. Practice uses separate resources before independent acceptance. Its results inform a later review, not edits to this candidate or model weights. Practice cannot approve a change, weaken acceptance, modify the user objective, or supply new inputs/seeds/budgets. Previous experiments may contain practice feedback; incomplete runs and a small sample do not demonstrate improved play.',
  'Propose one learning-system improvement grounded in the supplied observed Doom play. Keep the user objective and overrides intact. Return kind=guidance with complete replacement policy/prompts/skills fields, kind=executor for an isolated ranker, or kind=planner for isolated candidate-generation/context/retrieval code followed by Jev. Source changes contain complete TypeScript source plus optional replacement settings. Omitted fields stay unchanged. Do not change the host adapter, evaluator, budget, observations, engine input vocabulary or game state. Do not claim improvement before independent evaluation.',
  'Optional policy.outcomeWeights changes search preferences separately for survival/exploration/combat priorities. Each set contains health, kills, novelCells, items, secrets, ammo and exit weights within the provided schema. Omitting the field retains historical scoring. These weights only select gameplay futures; they cannot alter the independent acceptance metric or make dead futures eligible. Propose them only with a specific observed tradeoff to test.',
  'Optional policy.execution configures plan interruption and interaction cadence: damageBeforeReplan (health lost since plan start, default 8), nearbyThreatDistance (world units for newly observed threats, default 160), blockedAfterTicks (minimum movement-step age before a stationary-history check can replan, default 35), and usePulseTicks (press/release period, default 7). All four fields are required when supplied. The clock is 35 ticks/second. Values are bounded by the schema and pinned to each decision. Use observed execution failures to justify changes; these settings cannot alter collision rules, actor identity, legal inputs or independent acceptance metrics. Omission uses the historical defaults.',
  'Optional policy.motor configures movement and aim assistance: stalledTicks (failed movement ticks before escape, default 7), escapeTicks (maximum recovery-heading commitment, 70), escapeDistance (world units before leaving recovery, 64), minimumClearance (player-footprint clearance, 20), lookaheadTicks (velocity lookahead, 4), routeClearance (preferred clearance for an escape direction, 96), aimToleranceDegrees (fire alignment, 6) and turnToTargetDegrees (turn-assistance search angle, 80). Supply all eight within the schema bounds. These preferences run in both live play and independent comparisons under the recorded decision policy. They do not replace geometry, input legality, visibility checks or actor matching. Interaction pulses also honor policy.execution.usePulseTicks during movement. Omitted motor settings preserve historical behavior. Justify adjustments with observed interventions and outcomes rather than assuming wider aim or faster turning is always better.',
  'Experiments marked historicalBuild ran under an older host build. Use them as diagnostic experience, never as proof that a change qualifies now. Previous experiments may include savedSituation: measured incident outcomes, selected-plan statuses, recent stops and bounded choice counts. Use them to distinguish an unexecuted interaction, a failed approach, and a repeatedly completed plan that produced no progress. Do not repeat the same hypothesis merely because its code ran successfully. When testsSavedSituation is true, the host has saved the observed game position. Your proposal must improve gameplay from that exact position as well as pass the private regression cases. Address the observed failure; success on unrelated openings is insufficient.',
  'Use previousExperiments to avoid repeating rejected changes. execution failure counts distinguish insufficient committed gameplay, plans that never advance simulation time, and invalid preparation output. Address these failures before optimizing rewards; never request weaker coverage or larger evaluation budgets to conceal them. Their host-reported aggregate outcomes are evidence, not proof of a causal explanation; user context may differ. Private acceptance cases are not provided. Revise the hypothesis without inventing why a case failed.',
  'For built-in Jev, prompts support guide, action, plan and priority only. prompts.guide is the shared working gameplay guide applied to every Jev judgment. Rewrite it to reflect observed successes, failures and current strategy; leave the primary user objective and explicit constraints intact. Each prompt is at most 1024 characters. Use an empty guide to remove it. Complete replacement prompt objects must preserve any other slots you intend to keep. Prompts plus learned skills must fit 2048 UTF-8 JSON bytes; at most 8 unique skills. Skills guide decisions; they are not executable tools. The primary user guide and enabled user skills outrank learned guidance. User policy overrides are applied after artifact policy, except breadth: it is a maximum resource cap, not a fixed required count. Set policy.breadth to the number of simultaneous futures appropriate for the observed uncertainty, diversity and stagnation; runtime clamps it to observations.futureBudget.maximum. Increasing breadth alone cannot repair missing or repetitive plans.',
];
const taskParts = [
  'Planner output may use abi=doom-preparation/2 with an optional temporaryGoal. This is advisory guidance for Jev, never a replacement for the user objective. Return {key,instruction,reason,evidence:["current-state"],duration,target}; instruction/reason <=240 characters, duration 1..2100 game ticks (35 per second), key follows plan ID syntax. Target is {kind:"position",x,y,z,within:1..256}, {kind:"health",minimum:1..200}, {kind:"kills",minimum:1..65535} (absolute map kills), {kind:"key",color:"red"|"blue"|"yellow"}, or {kind:"exit"}. Ground the target in current observations; do not invent a key requirement. The host stamps run, map, user context, strategy identity and deadline, and checks completion from engine facts. Input temporaryGoal.current records the prior goal and terminal outcome. Reuse the same key while pursuing that same goal; repeated keys never renew deadlines or reactivate terminal goals. Only change the key for a meaningfully different goal justified by new evidence. Omission retains the existing goal until completion/expiry/invalidation. Old /1 output remains supported and cannot contain temporaryGoal.',
  ...sharedTaskParts,
  'Executor source is deterministic TypeScript, default export(input), running in networkless Node with no dependencies. Input is {state,objective,history,experience,actionTicks,planTicks,feedback,stats,userSkills,candidates:[{id,label,plan?}],learning:{revision,policy,basePolicy,prompts,skills}}. feedback includes measured wall clearance and occlusion. Rank the supplied feasible actions or conditional plans; do not return arbitrary game commands. Return exactly {selected:string,confidence:number,priority:"survival"|"exploration"|"combat",preferences:[{id,probability}]}. Include every supplied candidate once, probabilities sum to 1, all finite in [0,1], selected has maximal probability. No authoritative score may be returned. Source is stored unchanged and executed only in isolation. If currentSource is absent, the current executor is host-owned Jev code. Use evidence of stalled progress, damage and ineffective plans rather than inventing events or hardcoding a key/route objective.',
  'When observed plans repeatedly fail or the menu does not cover the user objective, prefer kind=planner. Its plans array REPLACES the default menu: add missing routes/interactions, replace ineffective choices and omit irrelevant ones. Diagnose missing knowledge versus missing actions. Do not invent a key location; explore reachable evidence-backed frontiers and interactions when its location is unknown. recentPlanFailures contains exact observed stop reasons/targets, including zero-game-time stops; repeating a failed target under a new label is not an improvement.',
  'Planner input state is RAW engine data, not observations.main.state (which is a separate summarized report). Use state.x/y/z/angle/health/ammo; there is no state.player or state.recentPlayerStates. Actor coordinates are actor.position.x/y/z, bearing is actor.relativeBearing, type is actor.engineType. Raw history entries have the same GameState shape. feedback uses its own nested structure: consult preparationExample instead of guessing paths. preparationExample is built with the runtime input builder from observed main state, with shortened history/memory arrays for size; defaultPlans contains the full host menu for that example. It illustrates the ABI, not a private acceptance case or a command to act on. preparationOutputSchema describes the exact return shape.',
  'Planner source is deterministic TypeScript default export(input), using the doom-preparation/1 ABI. Input contains state, objective, stats, userSkills, feedback, history (up to 10 observations), experience (the entire retained memory pool when enabled), experienceLimit, defaultHistoryIndices, defaultExperienceIndices, actionTicks, optional planTicks/defaultPlans/visited/previousPlan, and learning {revision,policy,prompts,skills}. Return {abi:"doom-preparation/1",historyIndices:number[],experienceIndices:number[],features:object,plans?:GamePlan[]}. Select actual pool indices, never fabricate memories. History indices are unique and chronological; experience indices are unique and at most experienceLimit (0 when disabled, maximum 8). Features contain at most 24 named finite numbers/booleans/strings (160 characters each), totaling at most 2048 UTF-8 JSON bytes. They are marked derived suggestions; they cannot replace current facts, guide or stats. Omit plans to retain the host menu, or generate 1-10 unique plans when planTicks is present; action-only mode forbids plans. Plans have {id,label,family?,steps:[{kind,target,label,maxTicks,within?,direction?}]}. IDs match [a-z][a-zA-Z0-9_-]{0,63}; labels <=120 characters; 1-12 steps. kind is face/move/attack/strafeAttack/use, direction if used is strafeLeft/strafeRight, within is 1-256, maxTicks is 1..min(planTicks,2100). target is {kind:"point"|"enemy"|"pickup",x,y,z,engineType?}, within 4096 horizontal units of current state. Actor targets must exactly match a current observed position and engineType; attacks require enemy targets. Point targets omit engineType. family if present is combat/health/resource/key/interaction/exit/exploration/cover/reposition/resupply. Host computes novelty and controls collision avoidance, aiming, interruption and horizon. Jev selects among the generated plans using your selected context, current stats and user guide. Optional model selects a jev-* alias; prompts/skills must meet the built-in Jev limits. Source cannot redefine reward/evaluation or invoke tools. previousPlan is host-observed local outcome feedback (id, label, status, reason, target, step, map, episode, startedTick, observedTick, ticksSinceStarted). Zero ticksSinceStarted means the plan stopped before time advanced. Avoid proposing the same failed target or route without relevant new evidence; IDs alone do not identify targets. Do not merely copy the host candidates if observed evidence calls for a different reachable route.',
];
const task = taskParts.join('\n');
const guidanceTask = sharedTaskParts.join('\n') + '\nPrefer a concise reusable strategic guide. Jev owns frequent execution. Change only what the observed failure requires; do not add unrelated instructions.';

export interface DoomProposalRecord {
  version: 1 | 2; training?: TrainingSelection; binding: VersionRef; id: string; createdAt: number; expiresAt: number; limits: SupervisorLimits; unrestricted?: boolean;
  request: SupervisorRequest<DoomPolicy, DoomProposalEvidence>; requestRevision: VersionRef;
  status: 'requested' | 'responded' | 'ready' | 'submitted' | 'failed' | 'cancelled' | 'interrupted';
  output?: unknown; receipt?: SupervisorReceipt; candidate?: LearningRevision<DoomPolicy>; reason?: string; error?: string;
}
const ref = z.strictObject({ id: z.string().min(1), version: z.string().min(1) });
const recordSchema = z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), training: trainingSchema.optional(), binding: ref, id: z.string().uuid(), createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(), limits: z.unknown(), unrestricted: z.boolean().optional(), request: z.unknown(), requestRevision: ref,
  status: z.enum(['requested', 'responded', 'ready', 'submitted', 'failed', 'cancelled', 'interrupted']),
  output: z.unknown().optional(), receipt: z.unknown().optional(), candidate: z.unknown().optional(), reason: z.string().optional(), error: z.string().optional() });
export function decodeDoomProposal(value: unknown): DoomProposalRecord {
  const parsed = recordSchema.parse(value) as DoomProposalRecord;
  validateSupervisorLimits(parsed.limits);
  if (!same(parsed.requestRevision, contentRevision('doom-supervisor-request', parsed.request)) || parsed.request.id !== parsed.id) throw new Error('Doom proposal request content mismatch');
  if (parsed.version === 1 && (parsed.training || parsed.request.evidence.training)) throw new Error('Legacy Doom proposal cannot contain training');
  if (parsed.candidate && (parsed.output as { training?: unknown })?.training && !parsed.training) throw new Error('Missing recorded Doom practice selection');
  if (parsed.training) {
    const menu = parsed.request.evidence.training;
    if (!menu || !same(parsed.training, (parsed.output as { training?: unknown })?.training)) throw new Error('Doom practice selection does not match the recorded proposal');
    validateTrainingSelection({ format: 1, revision: menu.catalog, maximumSelection: menu.maximumSelection,
      scenarios: menu.scenarios.map(scenario => ({ ...scenario, seed: 'host', input: null })) }, parsed.training);
  }
  return parsed;
}
export interface DoomProposalOptions {
  unrestricted?: boolean;
  trainingCatalog?: TrainingCatalog<DoomVmScenario>;
  /** Host has retained the supplied situation for a mandatory paired comparison. */
  testsSavedSituation?: boolean;
  historicalExperiments?: Record<string, unknown>[];
  id: string; kind?: LearningProposalKind; supervisor: DoomSupervisor; models: DoomLearningModels; executables: ExecutableStore;
  provider: SupervisorProvider<DoomPolicy, DoomProposalEvidence>; ledger: BudgetLedger; limits: SupervisorLimits;
  /** One exclusively owned durable store per id; reusing it never repeats a model call. */
  store: CheckpointStore<DoomProposalRecord>;
  capture(): SessionCheckpoint;
  /** Provider-specific failure receipt adapter. Unknown failures consume the full spending reservation. */
  failureReceipt?(error: unknown): SupervisorReceipt | undefined;
}

/** Generate and submit for review. This function never evaluates, activates or modifies a live game. */
const running = new WeakSet<CheckpointStore<DoomProposalRecord>>();
export function generateDoomProposal(options: DoomProposalOptions, signal: AbortSignal): Promise<DoomProposalRecord> {
  const store = options.store;
  if (running.has(store)) return Promise.reject(new Error('Doom proposal job is already running'));
  running.add(store);
  return generate({ ...options, limits: structuredClone(options.limits) }, signal).finally(() => { running.delete(store); });
}
async function generate(options: DoomProposalOptions, signal: AbortSignal): Promise<DoomProposalRecord> {
  z.string().uuid().parse(options.id); validateSupervisorLimits(options.limits);
  const kind = doomProposalKindSchema.optional().parse(options.kind);
  const trainingCatalog = options.trainingCatalog ? structuredClone(options.trainingCatalog) : undefined;
  const limits = structuredClone(options.limits), binding = options.supervisor.binding.identity;
  const previous = await options.store.load();
  if (previous) {
    const saved = decodeDoomProposal(previous);
    if (saved.id !== options.id || !same(saved.binding, binding)) throw new Error('Doom proposal belongs to another job or supervisor');
    if (saved.request.evidence.requestedKind !== kind) throw new Error('Doom proposal kind differs from its recorded request');
    const proposal = options.supervisor.snapshot().journal.proposals.find(item => item.id === saved.id);
    if (proposal) {
      if (!saved.candidate || !same(proposal.candidate, saved.candidate.revision) || !same(proposal.basedOn, saved.request.origin.activation)
        || !same(proposal.context, saved.request.origin.context) || proposal.reason !== saved.reason) throw new Error('Doom proposal publication does not match its generation record');
      await options.models.verify(saved.candidate); saved.status = 'submitted'; delete saved.error;
    } else if (saved.status === 'submitted') throw new Error('Submitted Doom proposal is missing from the supervisor journal');
    else if (['requested', 'responded', 'ready'].includes(saved.status)) { saved.status = 'interrupted'; saved.error = 'Generation interrupted; no model retry or automatic submission'; }
    await options.store.save(saved); return saved;
  }
  signal.throwIfAborted();
  const origin = options.supervisor.origin(), journal = options.supervisor.snapshot().journal, saved = options.capture();
  if (!same(saved.learning?.binding, binding)) throw new Error('Evidence is not from the supervised session');
  const current = journal.artifacts.find(item => same(item.revision, origin.activation.revision))!;
  const draftSchema = proposalSchema(current.model.id === 'typesafe' || current.model.id === 'prepared-doom-jev');
  const createdAt = Date.now();
  const request: SupervisorRequest<DoomPolicy, DoomProposalEvidence> = { id: options.id, origin, current,
    objective: saved.view.pendingObjective ?? saved.view.objective, capabilities: journal.rules.capabilities, contract: journal.rules.contract,
    // Zod adds non-enumerable runtime metadata; only its JSON schema is sent or hashed.
    task: kind ? (kind === 'guidance' ? guidanceTask : task) + '\nThe user requested kind=' + kind + '. Return that kind only; do not substitute another type of change.' : task,
    evidence: { ...(trainingCatalog ? { training: trainingMenu(trainingCatalog) } : {}), ...(options.testsSavedSituation ? { testsSavedSituation: true } : {}), ...(kind ? { requestedKind: kind } : {}), observations: doomSupervisorEvidence(saved, kind === 'guidance'), previousExperiments: [...(options.historicalExperiments ?? []), ...doomPreviousExperiments(journal, origin.context)].slice(-4) },
    outputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(kind ? draftSchema.options.find(schema => schema.shape.kind.value === kind)! : draftSchema))) };
  if (!kind || kind === 'planner') {
    const main = saved.worlds.find(world => world.view.id === saved.view.mainId)!;
    const { history, sampling } = supervisorExampleHistory(main.view.state, main.history);
    const experience = (saved.experience?.records ?? []).slice(-2);
    const example = await doomPreparationInput(current, main.view.state, request.objective, history, experience,
      supervisorTiming(saved).actionTicks, { policy: current.policy, planTicks: saved.view.trialDurationTicks ?? current.policy.trialTicks,
        stats: decisionStatistics(main.view.state, main.stats), skills: saved.view.skills, experiencePool: experience,
        visited: main.stats?.visited, pickups: main.pickups, previousPlan: previousPlanFeedback(main.plan, main.view.state) });
    request.evidence.preparationExample = example;
    if (sampling.repeatsCurrentState || sampling.repeatsEarlierEntry) request.evidence.preparationExampleHistory = sampling;
    request.evidence.preparationOutputSchema = JSON.parse(JSON.stringify(z.toJSONSchema(doomPreparationSchema)));
  }
  if (kind !== 'guidance' && current.executor.id === 'learning-executor') request.evidence.currentSource = (await options.executables.get(current.executor)).source;
  canonicalJson(request);
  const record: DoomProposalRecord = { version: trainingCatalog ? 2 : 1, binding, id: options.id, createdAt, expiresAt: createdAt + journal.rules.maxLifetimeMs,
    limits, ...(options.unrestricted ? { unrestricted: true } : {}), request, requestRevision: contentRevision('doom-supervisor-request', request), status: 'requested' };
  await options.store.save(record);
  try {
    if (!options.unrestricted && Buffer.byteLength(canonicalJson(request)) > limits.maxInputBytes) throw new Error('Doom proposal evidence exceeds the input budget');
    const outcome = await options.ledger.run({ owner: record.id, operation: 'doom-revision-proposal', reserve: options.unrestricted ? { supervisorCalls: 1 } : { supervisorCalls: 1, costMicros: limits.maxCostMicros },
      observe: options.unrestricted ? ['costMicros', 'inputTokens', 'outputTokens'] : ['inputTokens', 'outputTokens'] }, async () => {
      let output: Awaited<ReturnType<typeof options.provider.propose>> | undefined, failure: { error: unknown } | undefined;
      try { output = structuredClone(await options.provider.propose(structuredClone(request), structuredClone(limits), signal)); }
      catch (error) { failure = { error }; }
      const receipt = output?.receipt ?? (failure && options.failureReceipt?.(failure.error));
      if (receipt) {
        record.receipt = structuredClone(receipt);
        if (receipt.id !== record.id || !same(receipt.provider, options.provider.version)) throw new Error('Supervisor receipt identity mismatch');
      }
      if (output) { canonicalJson(output.draft); record.output = structuredClone(output.draft); record.status = 'responded'; }
      await options.store.save(record);
      const usage = receipt?.usage;
      return { value: { output, failure }, usage: { supervisorCalls: 1, ...(usage?.costMicros !== undefined ? { costMicros: usage.costMicros } : options.unrestricted ? {} : { costMicros: limits.maxCostMicros }),
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) } };
    }, signal);
    if (outcome.failure) throw outcome.failure.error;
    signal.throwIfAborted();
    if (!outcome.output || outcome.output.receipt.status !== 'complete') throw new Error('Supervisor did not return a completed proposal');
    const draft = draftSchema.parse(outcome.output.draft);
    if (kind && draft.kind !== kind) throw new Error('Supervisor returned ' + draft.kind + ' instead of requested ' + kind + ' proposal');
    if (draft.training) {
      if (!trainingCatalog) throw new Error('No practice catalog was offered');
      record.training = validateTrainingSelection(trainingCatalog, draft.training);
    }
    const { revision: _previous, ...fields } = current;
    if (draft.policy) fields.policy = draft.policy;
    if (draft.prompts) fields.prompts = draft.prompts;
    if (draft.skills) fields.skills = draft.skills;
    if (draft.kind === 'executor' || draft.kind === 'planner') {
      validateExecutableSource(draft.source);
      fields.executor = (await options.executables.put(draft.source)).revision;
      fields.model = draft.kind === 'executor' ? { id: 'isolated-doom-ranking', version: '1' }
        : { id: 'prepared-doom-jev', version: draft.model ?? (['typesafe', 'prepared-doom-jev'].includes(current.model.id) ? current.model.version : process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest') };
    }
    const candidate = doomLearningArtifact(fields); await options.models.verify(candidate);
    record.candidate = candidate; record.reason = draft.reason; record.status = 'ready'; await options.store.save(record);
    signal.throwIfAborted();
    await options.supervisor.submit({ id: record.id, candidate, reason: draft.reason, expiresAt: record.expiresAt, expected: origin });
    record.status = 'submitted'; await options.store.save(record);
  } catch (error) {
    record.status = signal.aborted ? 'cancelled' : 'failed'; record.error = error instanceof Error ? error.message.slice(0, 1000) : 'Proposal failed';
    await options.store.save(record);
  }
  return structuredClone(record);
}
function same(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b); }
