import { BudgetExhausted, canonicalJson, compareRevisions, type BudgetLedger, type EvaluationContract, type EvaluationPorts,
  type EvaluationRun, type EvaluationScenario, type LearningRevision, type PolicyPatch, type Qualification, type QualificationRequest } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { AiSkill } from '../../../packages/contracts/src/skills.ts';
import type { GameState } from '../../../packages/contracts/src/game.ts';
import type { SessionView } from '../../../packages/contracts/src/session.ts';
import { validateSkills } from './ai-skills.ts';
import { cappedLearningDoomPolicy, type DoomPolicy } from './doom-policy.ts';
import type { DoomLearningBinding } from './doom-learning.ts';
import type { DoomLearningModels } from './doom-learning-models.ts';
import { geometryFor } from './doom-geometry.ts';
import { navigateDoomInputs } from './doom-navigation.ts';
import type { Decision } from './jev.ts';
import { Session, type SessionCheckpoint, type SessionContinuation } from './session.ts';
import type { WorldRuntime } from './runtime.ts';
import type { CheckpointAdapter } from './checkpoints.ts';

export interface DoomEvaluationContext { maximumFutures?: number; objective: string; skills: AiSkill[]; overrides: PolicyPatch<DoomPolicy> }
export interface DoomEvaluationEvidence {
  initial: GameState; initialStats?: SessionView['stats']; final: GameState; session: SessionView;
  planFailures?: SessionCheckpoint['recentPlanFailures'];
  decisions: Array<{ state: GameState; decision: Decision }>;
}
export interface DoomEvaluationOptions<Input> {
  contract: EvaluationContract<Input>;
  context: DoomEvaluationContext;
  /** Trusted runtime provider. Meter initialization, every input, every fork/reconstruction and restore in this ledger. */
  create(runId: string, scenario: EvaluationScenario<Input>, ledger: BudgetLedger, signal: AbortSignal): Promise<WorldRuntime>;
  /** A fresh model registry per run. Isolated executors must use this ledger for all execution. Jev calls are metered here. */
  models(ledger: BudgetLedger): DoomLearningModels;
  /** Host-owned coverage gate, covered by the immutable scenario/evaluator contract. Terminal games are complete regardless of duration. */
  continuation?(scenario: EvaluationScenario<Input>): SessionContinuation | undefined;
  minimumSelectedTicks?(scenario: EvaluationScenario<Input>): number;
  checkpoints?(runId: string, ledger: BudgetLedger, signal: AbortSignal): CheckpointAdapter;
  /** Idempotently join/release every owned world/checkpoint, including partial creation. Persist unfinished cleanup. */
  cleanup(runId: string): Promise<void>;
  /** Identity must be covered by contract.evaluator. Never accept this function or weights from the candidate. */
  measure(evidence: DoomEvaluationEvidence): Record<string, number>;
  persistSession(runId: string, saved: SessionCheckpoint): Promise<void>;
  persistBudget: NonNullable<EvaluationPorts<Input, DoomEvaluationEvidence>['persistBudget']>;
  rejectAfterPair?: EvaluationPorts<Input, DoomEvaluationEvidence>['rejectAfterPair'];
  persistRun: NonNullable<EvaluationPorts<Input, DoomEvaluationEvidence>['persistRun']>;
  persistComparison(report: Awaited<ReturnType<typeof compareRevisions<Input, DoomEvaluationEvidence>>>): Promise<void>;
}

/** Independent matched runs through the same continuing-session loop used by the application. */
export async function qualifyDoomRevision<Input>(request: QualificationRequest<DoomPolicy>, options: DoomEvaluationOptions<Input>, signal: AbortSignal): Promise<Qualification> {
  request = structuredClone(request); options = { ...options };
  const contract = structuredClone(options.contract), context = structuredClone(options.context);
  const artifacts = [structuredClone(request.baseline), structuredClone(request.candidate)];
  if (!same(request.contract, contentRevision('doom-evaluation-contract', contract))) throw new Error('Doom evaluation contract identity mismatch');
  if (!context.objective.trim() || context.objective.length > 1000) throw new Error('Invalid evaluation objective');
  validateSkills(context.skills);
  const maximumFutures = context.maximumFutures ?? context.overrides.breadth ?? request.baseline.policy.breadth;
  if (context.maximumFutures !== undefined && context.overrides.breadth !== undefined && context.maximumFutures !== context.overrides.breadth) throw new Error('Evaluation future ceiling conflicts with the user override');
  for (const artifact of artifacts) cappedLearningDoomPolicy(artifact, context.overrides, maximumFutures);
  // Coverage failures still have useful observations. They must never acquire
  // metrics or a completed status merely because their evidence is retained.
  const incomplete = new Map<string, DoomEvaluationEvidence>();
  const withFailureEvidence = (run: EvaluationRun<DoomEvaluationEvidence>): EvaluationRun<DoomEvaluationEvidence> =>
    run.status !== 'complete' && !run.evidence && incomplete.has(run.id)
      ? { ...run, evidence: structuredClone(incomplete.get(run.id)!) } : run;
  const report = await compareRevisions(contract, artifacts[0]!.revision, artifacts[1]!.revision, {
    run: async (reference, scenario, ledger, current) => {
      const artifact = artifacts.find(item => same(item.revision, reference))!;
      const role = same(reference, request.baseline.revision) ? 'baseline' : 'candidate';
      const runId = contract.id + '/' + scenario.id + '/' + role;
      const models = options.models(ledger); await models.verify(artifact);
      const policy = cappedLearningDoomPolicy(artifact, context.overrides, maximumFutures).policy.values;
      if (policy.recovery.enabled && !options.checkpoints) throw new Error('This evaluator cannot exercise the requested checkpoint recovery policy');
      const decisions: DoomEvaluationEvidence['decisions'] = [];
      const model = models.model(artifact);
      const boundModel: typeof model = { decide: async (...args) => {
        const [state, objective, history, inner, ...rest] = args;
        const combined = AbortSignal.any([inner, current]);
        const invoke = () => model.decide(state, objective, history, combined, ...rest);
        const decision = artifact.model.id === 'typesafe'
          ? await ledger.run({ owner: runId, operation: 'jev', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
            const result = await invoke();
            if (!result.usage) throw new Error('Jev did not report usage');
            return { value: result, usage: { modelCalls: 1, ...result.usage } };
          }, combined) : await invoke();
        decisions.push({ state: structuredClone(state), decision: structuredClone(decision) }); return decision;
      } };
      const binding: DoomLearningBinding = {
        identity: contentRevision('doom-evaluation-binding', { proposal: request.proposalId, runId, revision: reference }), adapter: artifact.adapter,
        current: () => ({ activation: { revision: structuredClone(reference), epoch: 0 }, artifact: structuredClone(artifact) }),
        resolve: activation => {
          if (activation.epoch !== 0 || !same(activation.revision, reference)) throw new Error('Unknown evaluation revision');
          return structuredClone(artifact);
        },
        model: selected => { if (!same(selected, artifact)) throw new Error('Evaluation artifact changed'); return boundModel; },
      };
      const session = new Session(boundModel, { threshold: policy.forkThreshold, horizon: policy.trialTicks, branches: maximumFutures,
        paceMs: 0, frameTicks: 7 }, binding, context);
      session.setPersistence(saved => options.persistSession(runId, saved));
      if (options.checkpoints) session.setCheckpointAdapter(options.checkpoints(runId, ledger, current));
      session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
      try {
        const source = await options.create(runId, scenario, ledger, current);
        const initial = await source.state();
        if (!initial.alive || initial.phase !== 'level') throw new Error('Evaluation scenario must start with a living player in a level');
        await session.initialize(source, options.continuation?.(scenario));
        const initialStats = session.snapshot().stats;
        current.throwIfAborted();
        let terminal = false;
        const stop = () => { void session.pause().catch(() => {}); };
        const changed = () => {
          const view = session.snapshot(), main = view.worlds.find(world => world.id === view.mainId)!;
          if (!terminal && (!main.state.alive || main.state.phase !== 'level' || main.state.map !== initial.map || main.state.episode !== initial.episode)) { terminal = true; stop(); }
        };
        current.addEventListener('abort', stop, { once: true }); session.on('change', changed);
        try { session.resume(); await session.idle(); }
        finally { current.removeEventListener('abort', stop); session.removeListener('change', changed); }
        current.throwIfAborted();
        const view = session.snapshot(), final = view.worlds.find(world => world.id === view.mainId)!.state;
        const exhausted = session.failureCause instanceof BudgetExhausted;
        if (view.error && !exhausted) throw session.failureCause ?? new Error(view.error);
        const saved = session.checkpoint();
        await options.persistSession(runId, saved);
        const minimum = options.minimumSelectedTicks?.(scenario) ?? 0;
        if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('Invalid minimum selected gameplay duration');
        const selectedTicks = Math.round(((view.stats?.seconds ?? 0) - (initialStats?.seconds ?? 0)) * 35);
        const evidence = JSON.parse(JSON.stringify({ initial, initialStats, final, session: view, decisions, planFailures: saved.recentPlanFailures })) as DoomEvaluationEvidence;
        if (!terminal && selectedTicks < minimum) {
          incomplete.set(runId, evidence);
          throw new Error(`Insufficient selected gameplay: ${selectedTicks}/${minimum} required ticks; unfinished futures cannot qualify a revision`);
        }
        return { ending: terminal ? 'terminal' : exhausted ? 'budget' : 'complete', evidence };
      } finally {
        try { await session.close(); } finally { await options.cleanup(runId); }
      }
    },
    measure: evidence => options.measure(evidence),
    persistBudget: options.persistBudget, persistRun: run => options.persistRun(withFailureEvidence(run)), rejectAfterPair: options.rejectAfterPair,
  }, signal);
  report.runs = report.runs.map(withFailureEvidence);
  await options.persistComparison(report);
  return { baseline: request.baseline.revision, candidate: request.candidate.revision, context: request.context, contract: request.contract,
    accepted: report.accepted, reason: report.reason, evidence: report };
}

/** Versioned host objective: survive, exit, collect useful items and make novel progress. No displacement reward. */
export function doomSurvivalProgress(evidence: DoomEvaluationEvidence): Record<string, number> {
  const { initial, final, session } = evidence, stats = session.stats!;
  const exited = final.map !== initial.map || final.episode !== initial.episode || final.phase === 'intermission' || final.phase === 'finale';
  const kills = stats.kills - (evidence.initialStats?.kills ?? initial.kills), items = stats.items - (evidence.initialStats?.items ?? initial.items), secrets = stats.secrets - (evidence.initialStats?.secrets ?? initial.secrets), cells = Math.max(0, stats.cells - (evidence.initialStats?.cells ?? 1));
  return { score: Number(exited) * 100000 + Number(final.alive) * 10000 + kills * 100 + items * 10 + secrets * 50 + cells + final.health,
    kills, items, secrets, health: final.health, damage: stats.damage - (evidence.initialStats?.damage ?? 0), cells, gameSeconds: stats.seconds - (evidence.initialStats?.seconds ?? 0), exited: Number(exited), alive: Number(final.alive) };
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
