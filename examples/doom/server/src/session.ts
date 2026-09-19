import { decisionLeadTicks, decisionStateIsCurrent, decisionFactChanges } from './doom-decision-freshness.ts';
import { advanceDoomTemporaryGoal, decodeDoomTemporaryGoal } from './doom-temporary-goal.ts';
import { decisionOptionsView } from './decision-options.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { failedPlanFeedback, previousPlanFeedback, type PreviousPlanFeedback } from './plan-feedback.ts';
import { isDeepStrictEqual } from 'node:util';
import { scoreDoomOutcome, type DoomOutcomeWeights } from './doom-outcome.ts';
import { doomLearningProvenance, verifyDoomLearning, type DoomLearningBinding, type SavedDoomLearning } from './doom-learning.ts';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { GoalFrame, LearningRevision, PolicyPatch, VersionRef } from '@multiverse/gameplay-harness';
import { doomPolicy, learningDoomPolicy, cappedLearningDoomPolicy, restoreDoomPolicy, type DoomPolicy, type DoomPolicyRecord } from './doom-policy.ts';
import { vmResourceStateSchema, type VmResourceState, type VmOverview } from '../../contracts/src/vm.ts';
import { assertVmBudget, resourceTotals, type VmSettingsStore } from './vm-settings.ts';
import { CheckpointRecovery, decideCurrent, DecisionPrefetch, ExecutionGate, LearningLoop, type LoopJudgment, type RoutedJudgment, runTrials, waitFor, WorldLifecycle, WorldForks, type ForkIntent } from '@multiverse/gameplay-harness';
import { discardForcedKeyStrategy } from './session-policy-upgrade.ts';
import { validateSkills, skillInput } from './ai-skills.ts';
import { activeSkills, type AiSkill } from '../../contracts/src/skills.ts';
import { observePickups, type PickupMemory } from './doom-pickup-memory.ts';
import { decisionStatistics } from './decision-context.ts';
import { geometryFor } from './doom-geometry.ts';
import { startPlan, stopPlan, planInputs, planView, type PlanExecution, type GamePlan } from './doom-plans.ts';
import type { DoomControlPolicy } from './doom-motor-policy.ts';
import { planNavigationMemory, type NavigationMemory } from './doom-navigation.ts';
import { randomUUID } from 'node:crypto';
import { advanceStats, initialStats, type TimelineStats } from './run-stats.ts';
import type { CheckpointAdapter } from './checkpoints.ts';
import { ExperienceMemory, type Experience } from './experience.ts';
import { EventEmitter } from 'node:events';
import type { GameState, Input } from '../../contracts/src/game.ts';
import type { RecoveryPolicy, SessionView, WorldView } from '../../contracts/src/session.ts';
import type { WorldRuntime } from './runtime.ts';
import { actions, type ActionId, type DecisionMaker, type JevDecisionTrace, type Decision, type DecisionContext, type Priority } from './jev.ts';

type World = { lastJevDecision?: JevDecisionTrace; view: WorldView; runtime?: WorldRuntime; frame: Buffer; history: GameState[]; stats: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution };
type DoomCandidate = { action: ActionId; label: string; probability: number; plan?: GamePlan };
type DoomLoopLimits = { breadth: number; horizon: number; actionTicks: number };
type DoomDecisionData = { learning?: WorldView['learning']; decision: Decision; experiences: Experience[]; policy: DoomPolicyRecord; skillsRevision: number };
type DoomJudgment = LoopJudgment<DoomCandidate, DoomDecisionData>;
type DecisionQuestion = {
  key: string; state: GameState; history: GameState[]; model: DecisionMaker;
  objective: string; skillsRevision: number; experience: Experience[]; policy: DoomPolicyRecord;
  learning?: WorldView['learning']; context: DecisionContext; actionTicks: number;
};
type DecisionAnswer = { observedTick: number; decision: Decision; experience: Experience[]; policy: DoomPolicyRecord;
  skillsRevision: number; learning?: WorldView['learning'] };
type DoomFork = ForkIntent & {
  learning?: WorldView['learning'];
  policyRevision?: WorldView['policyRevision']; actions: ActionId[]; horizon?: number; actionTicks?: number;
  plans?: Array<GamePlan | undefined>; skillsRevision?: number; baseline?: GameState;
  candidates?: Array<{ label: string; probability: number }>;
};
type Experiment = { id: string; action: ActionId; remaining: number; nextDecisionTick?: number; actionStart?: GameState };
type RecoveryPoint = { id: string; reference: string; createdAt: number; world: WorldView; history: GameState[]; stats: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution };
type RecoveryState = {
  policy: RecoveryPolicy; points: RecoveryPoint[]; cleanup: string[]; failures: number;
  pendingCapture?: string; pendingRestore?: { id: string; pointId: string }; message?: string;
};
const newRecovery = (): RecoveryState => ({ policy: { enabled: false, maxRetries: 2, healthLoss: 15, stallSeconds: 15 }, points: [], cleanup: [], failures: 0 });
const newAttempts = () => ({ ticks: 0, kills: 0, deaths: 0, rejectedBatches: 0, retries: 0, rollbacks: 0, planFailures: 0 });
export interface SessionCheckpoint {
  policies?: DoomPolicyRecord[];
  version: 1 | 2 | 3;
  goalScopeId?: string;
  learning?: SavedDoomLearning;
  recovery?: RecoveryState;
  attempts?: Omit<ReturnType<typeof newAttempts>, 'planFailures'> & { planFailures?: number };
  recentPlanFailures?: Array<{ worldId: string; feedback: PreviousPlanFeedback }>;
  view: SessionView;
  worlds: Array<{ lastJevDecision?: JevDecisionTrace; view: WorldView; identity?: string; frame: string; history: GameState[]; stats?: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution }>;
  experiments: Experiment[];
  baseline?: GameState;
  priority: Priority;
  experience?: { enabled: boolean; records: Experience[]; capacity?: number; contextLimit?: number };
  cleanup?: Array<{ id: string; identity: string }>;
  recordingResetTo?: string;
  pendingFork?: DoomFork;
}
/** Host-captured knowledge for a fresh evaluation runtime, without live identities or control settings. */
export interface SessionContinuation {
  state: GameState; history: GameState[]; stats?: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution;
  experience: Experience[];
  temporaryGoal?: WorldView['temporaryGoal'];
  goalScopeId?: string;
}
export function sessionContinuation(saved: SessionCheckpoint): SessionContinuation {
  const world = saved.worlds.find(world => world.view.id === saved.view.mainId);
  if (!world) throw new Error('Continuation requires the saved main world');
  return JSON.parse(JSON.stringify({ state: world.view.state, history: world.history, stats: world.stats,
    navigation: world.navigation, pickups: world.pickups, plan: world.plan, temporaryGoal: world.view.temporaryGoal, goalScopeId: saved.goalScopeId, experience: saved.experience?.records ?? [] })) as SessionContinuation;
}
export interface SessionInitialContext { overrides?: PolicyPatch<DoomPolicy>; skills?: AiSkill[]; objective?: string }
export function outcomeScore(before: GameState, after: GameState, priority: Priority, novelCells = 0, shaping?: Readonly<DoomOutcomeWeights>): number {
  return scoreDoomOutcome(before, after, priority, novelCells, shaping);
}

export class Session extends EventEmitter {
  private goalScopeId: string = randomUUID();
  private revisions?: DoomLearningBinding;
  private readonly decisionLatency = new Map<string, number>();
  private readonly nextDecisions = new Map<string, DecisionPrefetch<DecisionQuestion, DecisionAnswer>>();
  private userOverrides: PolicyPatch<DoomPolicy> = {};
  private changingRevision = false;
  private readonly revisionTurn = new AsyncLocalStorage<boolean>();
  private queuedRevision?: { id: string; work: () => Promise<unknown>; status: 'waiting' | 'applying' | 'applied' | 'failed'; error?: unknown };

  /** A tested revision waits for a plan/fork boundary while normal play continues. */
  queueLearningActivation(id: string, work: () => Promise<unknown>): 'pending' | 'activated' {
    if (this.queuedRevision?.id !== id) {
      if (this.queuedRevision && ['waiting', 'applying'].includes(this.queuedRevision.status)) throw new Error('Another learning activation is queued');
      this.queuedRevision = { id, work, status: 'waiting' };
    }
    if (this.queuedRevision.status === 'failed') throw this.queuedRevision.error;
    return this.queuedRevision.status === 'applied' ? 'activated' : 'pending';
  }
  cancelLearningActivation(id: string): void {
    if (this.queuedRevision?.id === id && this.queuedRevision.status !== 'applying') this.queuedRevision = undefined;
  }
  private async applyQueuedLearningActivation(): Promise<void> {
    const queued = this.queuedRevision;
    if (!queued || queued.status !== 'waiting' || this.experiments.length || this.view.manualChoiceRequired
      || this.worlds.get(this.mainId)?.plan?.status === 'running'
      || [...this.worlds.values()].some(world => world.view.controller === 'human')) return;
    queued.status = 'applying';
    try {
      await this.revisionTurn.run(true, queued.work); queued.status = 'applied';
      await this.persist();
    } catch (error) {
      queued.status = 'failed'; queued.error = error;
      this.say(this.mainId, 'Background learning could not apply its improvement. See self-learning in settings.');
    }
  }
  /** Capture a host-owned evaluation snapshot at the next safe decision boundary.
   * The caller journals ownership before calling and retains/releases the snapshot.
   * Cancellation joins an already-dispatched capture before returning to its owner.
   */
  async captureLearningIncident(reference: string, signal: AbortSignal): Promise<SessionCheckpoint> {
    if (!/^mom-checkpoint-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:recovery$/.test(reference)) throw new Error('Invalid learning checkpoint reference');
    if (!this.checkpointAdapter) throw new Error('Execution checkpoints are unavailable');
    signal.throwIfAborted();
    const capture = () => this.revisionBoundary(async () => {
      signal.throwIfAborted();
      this.applyGuide();
      const world = this.world(this.mainId), runtime = world.runtime;
      if (!runtime) throw new Error('Main runtime is unavailable');
      const before = await runtime.state();
      if (!before.alive || before.phase !== 'level') throw new Error('Learning checkpoint requires a living player inside a level');
      if (!isDeepStrictEqual(before, world.view.state)) throw new Error('Learning checkpoint observation does not match the runtime');
      await this.checkpointAdapter!.capture(runtime, reference);
      const after = await runtime.state();
      if (!isDeepStrictEqual(before, after)) throw new Error('Game state changed during learning checkpoint capture');
      signal.throwIfAborted();
      return this.checkpoint();
    });
    if (!this.view.running && !this.execution.busy && !this.experiments.length
      && !this.view.manualChoiceRequired && this.worlds.get(this.mainId)?.plan?.status !== 'running') return capture();
    return new Promise<SessionCheckpoint>((resolve, reject) => {
      const id = 'incident:' + reference;
      let started = false;
      const cancel = () => {
        if (started) return; // The owner must wait for dispatched capture before cleanup.
        this.cancelLearningActivation(id); reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        this.queueLearningActivation(id, async () => {
          started = true;
          try { resolve(await capture()); } catch (error) { reject(error); }
          finally { signal.removeEventListener('abort', cancel); }
        });
      } catch (error) { signal.removeEventListener('abort', cancel); reject(error); }
    });
  }
  /** Surface an applied supervisor change in the existing session commentary. */
  async reportLearningImprovement(reason: string): Promise<void> {
    this.say(this.mainId, `Supervisor applied a tested improvement: ${reason.slice(0, 280)}`);
    await this.persist(); this.emitView();
  }
  private learningError?: unknown;
  private failure?: unknown;
  get failureCause(): unknown { return this.failure; }
  private vmSettings?: VmSettingsStore;
  setVmSettings(settings: VmSettingsStore) { this.vmSettings = settings; }
  async vmOverview(): Promise<VmOverview> {
    if (!this.vmSettings) throw new Error('VM settings unavailable');
    const worlds = await Promise.all([...this.worlds.values()].filter(w => w.runtime).map(async w => {
      if (!w.runtime?.resources) throw new Error('Runtime does not expose VM resources');
      return { id: w.view.id, label: w.view.label, role: w.view.role, resources: await w.runtime.resources() };
    }));
    return { settings: this.vmSettings.settings, worlds, totals: resourceTotals(worlds.map(w => w.resources)) };
  }
  async modifyVm(id: string, input: VmResourceState, dryRun: boolean) {
    this.requireIdle();
    const resources = vmResourceStateSchema.parse(input);
    const world = this.world(id);
    if (world.view.role === 'archived' || !world.runtime?.modifyResources) throw new Error('This world has no configurable live VM');
    const runtime = world.runtime;
    let result: Awaited<ReturnType<NonNullable<WorldRuntime['modifyResources']>>> | undefined;
    await this.execution.run(async () => {
      if (!dryRun && this.vmSettings) {
        const overview = await this.vmOverview();
        assertVmBudget(overview.worlds.map(w => w.id === id ? resources : w.resources), overview.settings.budget);
      }
      result = await runtime.modifyResources!(resources, dryRun);
    });
    return result!;
  }
  private policies = new Map<string, DoomPolicyRecord>();
  private recovery = newRecovery();
  private attempts = newAttempts();
  private recentPlanFailures: NonNullable<SessionCheckpoint['recentPlanFailures']> = [];
  private checkpointAdapter?: CheckpointAdapter;
  setCheckpointAdapter(adapter: CheckpointAdapter) { this.checkpointAdapter = adapter; }
  private memory = new ExperienceMemory();
  private memoryEnabled = false;
  private memoryPerDecision = 2;
  private memoryUsed = 0;
  private memoryEvidence: NonNullable<SessionView['experience']>['evidence'] = [];
  private readonly lifecycle = new WorldLifecycle<World, WorldRuntime>({
    metadata: world => world.view,
    persist: () => this.persist(),
    retainReplay: id => this.retainRecording?.(id) ?? Promise.resolve(),
    stageSelection: id => this.stageSelection(id),
  });
  private readonly checkpointRecovery = new CheckpointRecovery<RecoveryPoint, World, WorldRuntime>(this.lifecycle, {
    journal: () => this.recovery,
    adapter: () => {
      if (!this.checkpointAdapter) throw new Error('Execution checkpoints are unavailable');
      return this.checkpointAdapter;
    },
    point: world => this.recoveryPoint(world),
    attach: (runtime, point) => this.attachRollback(runtime, point),
    restoreId: () => `mom-rollback-${randomUUID().slice(0, 12)}`,
    persist: () => this.persist(),
    retainReplay: point => this.retainRecording?.(point.world.id) ?? Promise.resolve(),
    stageRestore: () => this.stageRollback(),
  });
  private readonly forks = new WorldForks<DoomFork, World, WorldRuntime>(this.lifecycle, {
    pending: () => this.pendingFork,
    setPending: intent => { this.pendingFork = intent; },
    persist: () => this.persist(),
    fork: (runtime, ids) => runtime.branch(ids),
    attach: (runtime, source, intent, index) => this.attachFork(runtime, source, intent, index),
    stage: (children, source, intent) => this.stageFork(children, source, intent),
    retain: world => this.record?.(world.view, world.frame) ?? Promise.resolve(),
  });
  private readonly learning = new LearningLoop<World, DoomCandidate, DoomDecisionData, DoomLoopLimits>({
    state: {
      main: () => this.world(this.mainId),
      terminal: world => !world.view.state.alive,
      batch: () => this.experiments.length ? this.view.stage === 'choosing' ? 'complete' : 'exploring' : 'none',
    },
    planning: {
      prepare: (world, manual) => {
        this.applyGuide();
        if (manual && world.plan?.status === 'running') {
          stopPlan(world.plan, 'replan', 'manual comparison requested'); world.view.plan = planView(world.plan);
        }
      },
      continuing: world => world.plan?.status === 'running',
      continue: async (world, signal) => { await this.advancePlan(world, Math.max(0, world.plan!.untilTick - world.view.state.tick), signal); },
      limits: () => ({ breadth: this.view.effectiveFutures ?? this.view.maxFutures ?? this.options.branches, horizon: this.view.trialDurationTicks ?? this.options.horizon, actionTicks: this.decisionTicks() }),
      decide: (world, limits, signal) => this.judge(world, limits, signal),
      routing: world => ({ threshold: this.view.forkThreshold ?? this.options.threshold, stalled: world.view.state.tick - world.stats.lastProgressTick >= 350, retries: this.recovery.failures }),
      execute: (world, judgment, limits, signal) => this.executeDecision(world, judgment, limits, signal),
    },
    comparison: {
      explore: signal => this.explore(signal),
      evaluate: () => {
        const winner = this.rankExperiments()[0];
        return { winner, rejected: !winner || Boolean(this.recovery.policy.enabled && this.recovery.points.length && this.poorOutcome(winner)) };
      },
      create: (world, candidates, judgment, limits, signal) => this.createComparison(world, candidates, judgment, limits, signal),
      promote: async world => { this.recovery.failures = 0; await this.select(world.view.id); },
      review: (_world, signal) => this.reviewWinner(signal),
      afterPromotion: signal => this.waitFor(this.options.continueMs ?? 0, signal),
    },
    recovery: {
      checkpointNeeded: world => Boolean(this.recovery.policy.enabled && this.checkpointAdapter && (!this.recovery.points.length || this.shouldCheckpoint(world))),
      checkpoint: () => this.capturePoint(),
      terminal: async () => {
        if (this.recovery.policy.enabled && this.recovery.points.length) await this.restorePoint(this.recovery.points.at(-1)!.id);
      },
      reject: signal => this.rejectBatch(signal),
    },
    observe: {
      stage: stage => { this.view.stage = stage; this.emitView(); },
      decision: (world, judgment, routing, limits) => this.recordDecision(world, judgment, routing, limits),
    },
  });
  private get worlds() { return this.lifecycle.worlds; }
  private set worlds(worlds: ReadonlyMap<string, World>) { this.lifecycle.replace(worlds); }
  private get mainId() { return this.lifecycle.mainId; }
  private set mainId(id: string) { this.lifecycle.mainId = id; }
  private readonly execution = new ExecutionGate();
  private get active() { return this.execution.pending; }
  private experiments: Experiment[] = [];
  private baseline?: GameState;
  private priority: Priority = 'exploration';
  private sequence = 0;
  private get cleanup() { return this.lifecycle.cleanup; }
  private set cleanup(entries: Array<{ id: string; identity: string }>) { this.lifecycle.cleanup = entries; }
  private recordingResetTo?: string;
  private pendingFork?: SessionCheckpoint['pendingFork'];
  private control?: (state: GameState, inputs: Input[], navigation: NavigationMemory, policy?: DoomControlPolicy) => Promise<Input[]>;
  setControls(control: NonNullable<Session['control']>) { this.control = control; }
  private record?: (world: WorldView, frame: Buffer) => Promise<void>;
  setRecorder(record: (world: WorldView, frame: Buffer) => Promise<void>) { this.record = record; }
  private retainRecording?: (id: string) => Promise<void>;
  setMainRecorder(retain: (id: string) => Promise<void>) { this.retainRecording = retain; }
  private save?: (checkpoint: SessionCheckpoint) => Promise<void>;
  private view: Omit<SessionView, 'mainId'> = { worlds: [], running: false, busy: false, stage: 'ready', planningMode: 'plans', objective: 'survive and reach the exit', commentary: [] };
  constructor(private readonly decisionMaker: DecisionMaker, private readonly options: { threshold: number; horizon: number; branches: number; paceMs: number; frameTicks?: number; reviewMs?: number; continueMs?: number } = { threshold: 0.75, horizon: 210, branches: 4, paceMs: 1000 / 35, frameTicks: 1, reviewMs: 0, continueMs: 0 }, revisions?: DoomLearningBinding, initial: SessionInitialContext = {}) {
    super(); this.revisions = revisions;
    const overrides = initial.overrides ?? {};
    if (revisions) { learningDoomPolicy(revisions.current().artifact, overrides); this.userOverrides = structuredClone(overrides); }
    else if (Object.keys(overrides).length) throw new Error('Learning overrides require a revision binding');
    if (initial.objective !== undefined) {
      if (!initial.objective.trim() || initial.objective.length > 1000) throw new Error('Invalid initial objective');
      this.view.objective = initial.objective;
    }
    if (initial.skills) this.view.skills = validateSkills(initial.skills);
    this.view.maxFutures = overrides.breadth ?? options.branches; this.view.forkThreshold = options.threshold;
    this.view.winnerDelaySeconds = (options.reviewMs ?? 0) / 1000; this.view.decisionIntervalTicks = 35; this.view.trialDurationTicks = options.horizon;
  }

  async initialize(runtime: WorldRuntime, continuation?: SessionContinuation) {
    if (this.worlds.size) throw new Error('Session already initialized');
    this.applyLearningPolicy();
    await this.add(runtime, { generation: 0, role: 'main', label: 'main session' });
    this.mainId = runtime.id;
    if (continuation) {
      const world = this.world(runtime.id), seed = structuredClone(continuation);
      if (!isDeepStrictEqual(seed.state, world.view.state)) throw new Error('Continuation does not match the restored game state');
      if (seed.plan?.status === 'running') throw new Error('Continuation must start at a completed plan boundary');
      if (seed.temporaryGoal) {
        const goal = decodeDoomTemporaryGoal(seed.temporaryGoal);
        if (!seed.goalScopeId || goal.record.created.scope.id !== seed.goalScopeId) throw new Error('Continuation goal belongs to another run');
        this.goalScopeId = seed.goalScopeId; world.view.temporaryGoal = goal;
        this.advanceGoal(world);
      }
      world.history = seed.history; world.stats = seed.stats ?? world.stats;
      world.navigation = seed.navigation; world.pickups = seed.pickups; world.plan = seed.plan;
      this.memory.records = seed.experience.slice(-this.memory.capacity);
    }
    await this.retainRecording?.(runtime.id);
    this.say(runtime.id, 'Main session ready. Resume AI play or take control.');
    this.emitView();
  }
  setPersistence(save: (checkpoint: SessionCheckpoint) => Promise<void>) { this.save = save; }
  checkpoint(): SessionCheckpoint {
    const hasGoals = [...this.worlds.values()].some(world => world.view.temporaryGoal) || this.recovery.points.some(point => point.world.temporaryGoal);
    return structuredClone({ version: hasGoals ? 3 : this.revisions ? 2 : 1, ...(hasGoals ? { goalScopeId: this.goalScopeId } : {}), ...(this.revisions ? { learning: { binding: this.revisions.identity, overrides: this.userOverrides } } : {}), policies: [...this.policies.values()], recovery: this.recovery, attempts: this.attempts, recentPlanFailures: this.recentPlanFailures, experience: { enabled: this.memoryEnabled, records: this.memory.records, capacity: this.memory.capacity, contextLimit: this.memoryPerDecision }, view: this.snapshot(), experiments: this.experiments, baseline: this.baseline, priority: this.priority, cleanup: this.cleanup, recordingResetTo: this.recordingResetTo, pendingFork: this.pendingFork,
      worlds: [...this.worlds.values()].map(w => ({ lastJevDecision: w.lastJevDecision, view: w.view, identity: w.runtime?.identity, frame: w.frame.toString('base64'), history: w.history, stats: w.stats, navigation: w.navigation, pickups: w.pickups, plan: w.plan })) });
  }
  private async persist() { await this.save?.(this.checkpoint()); }
  async restore(saved: SessionCheckpoint, reconnect: (id: string, identity: string) => Promise<WorldRuntime>,
    recoverPending?: (id: string) => Promise<WorldRuntime | undefined>,
    destroyPending?: (id: string, identity: string) => Promise<void>) {
    if (this.worlds.size) throw new Error('Session already initialized');
    if (saved.version === 2 || (saved.version === 3 && saved.learning)) {
      if (!saved.learning || !this.revisions || !isDeepStrictEqual(saved.learning.binding, this.revisions.identity)) throw new Error('Supervised Doom session requires its original learning binding');
      this.userOverrides = structuredClone(saved.learning.overrides);
      learningDoomPolicy(this.revisions.current().artifact, this.userOverrides);
    } else if ((saved.version !== 1 && saved.version !== 3) || saved.learning || this.revisions) throw new Error('Restore the legacy Doom session before explicitly adopting a learning binding');
    const savedGoals = [...saved.worlds.map(world => world.view.temporaryGoal), ...(saved.recovery?.points ?? []).map(point => point.world.temporaryGoal), ...saved.view.worlds.map(world => world.temporaryGoal)].filter(goal => goal !== undefined);
    if (saved.version === 3) {
      if (typeof saved.goalScopeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved.goalScopeId)) throw new Error('Invalid saved temporary-goal scope');
      for (const goal of savedGoals) {
        const decoded = decodeDoomTemporaryGoal(goal);
        if (decoded.record.created.scope.id !== saved.goalScopeId) throw new Error('Saved goal belongs to another run');
      }
      this.goalScopeId = saved.goalScopeId;
    } else if (savedGoals.length || saved.goalScopeId) throw new Error('Temporary goals require session format 3');
    const learningReferences = [saved.pendingFork?.learning, saved.view.decision?.learning, ...saved.worlds.map(world => world.view.learning), ...(saved.recovery?.points ?? []).map(point => point.world.learning)];
    for (const reference of learningReferences) if (reference) verifyDoomLearning(this.revisions, reference);
    if (saved.version === 2 || (saved.version === 3 && saved.learning)) {
      const active = this.revisions!.current().activation;
      const batchReferences = [...saved.experiments.map(item => saved.worlds.find(world => world.view.id === item.id)?.view.learning),
        ...(saved.pendingFork ? [saved.pendingFork.learning] : [])];
      if (batchReferences.some(reference => !reference || !isDeepStrictEqual(reference.activation, active))) throw new Error('Unresolved Doom comparison belongs to a different active learning revision');
    }
    saved = discardForcedKeyStrategy(saved);
    for (const record of saved.policies ?? []) {
      const verified = restoreDoomPolicy(record);
      this.policies.set(verified.revision.version, verified);
    }
    const references = [saved.pendingFork?.policyRevision, saved.view.decision?.policyRevision, saved.view.decision?.routingPolicyRevision,
      ...saved.worlds.map(world => world.view.policyRevision), ...(saved.recovery?.points ?? []).map(point => point.world.policyRevision)];
    for (const reference of references) if (reference && (!this.policies.has(reference.version) || this.policies.get(reference.version)!.revision.id !== reference.id)) {
      throw new Error('Saved artifact refers to an unavailable policy revision');
    }
    const mains = saved.worlds.filter(w => w.view.role === 'main');
    if (mains.length !== 1 || mains[0]!.view.id !== saved.view.mainId) throw new Error('Saved session has an invalid main world');
    this.recovery = structuredClone(saved.recovery ?? newRecovery());
    this.attempts = { ...newAttempts(), ...structuredClone(saved.attempts) };
    this.recentPlanFailures = structuredClone(saved.recentPlanFailures ?? []).slice(-16);
    this.memory.setCapacity(saved.experience?.capacity ?? 128);
    this.memoryPerDecision = saved.experience?.contextLimit ?? 2;
    this.memory.records = structuredClone(saved.experience?.records ?? []).slice(-this.memory.capacity);
    this.memoryEnabled = saved.experience?.enabled ?? false;
    const { mainId, ...restoredView } = structuredClone(saved.view);
    this.mainId = mainId;
    this.view = restoredView;
    this.view.skills = validateSkills(saved.view.skills ?? []);
    this.view.forkThreshold ??= this.options.threshold;
    this.view.maxFutures ??= this.options.branches;
    this.view.planningMode ??= 'plans';
    this.view.decisionIntervalTicks ??= 35;
    this.view.trialDurationTicks ??= this.options.horizon;
    this.view.directorWorldIds ??= saved.experiments.length ? saved.experiments.map(e => e.id) : saved.view.comparison?.candidateIds;
    this.view.winnerDelaySeconds ??= (this.options.reviewMs ?? 0) / 1000;
    this.view.running = false; this.view.busy = false; this.view.error = undefined;
    this.experiments = structuredClone(saved.experiments);
    this.baseline = saved.baseline; this.priority = saved.priority;
    this.recordingResetTo = saved.recordingResetTo;
    this.pendingFork = saved.pendingFork;
    this.cleanup = saved.cleanup ?? [];
    this.sequence = Math.max(0, ...this.view.commentary.map(c => c.id));
    for (const record of saved.worlds) {
      const view = structuredClone(record.view);
      view.thinking = false;
      view.controller = 'ai'; // Browser control leases do not survive a backend restart.
      const runtime = record.identity ? await reconnect(view.id, record.identity) : undefined;
      if (view.role !== 'archived' && !runtime) throw new Error(`Missing runtime identity for ${view.id}`);
      const stats = structuredClone(record.stats ?? initialStats(view.state, true));
      if (runtime) {
        const actual = await runtime.state(), previousKills = stats.kills;
        advanceStats(stats, view.state, actual);
        if (view.role === 'experiment' && view.trial) view.trial.kills += stats.kills - previousKills;
        view.state = actual;
      }
      view.status = view.role === 'archived' || !view.state.alive ? 'ended' : 'paused';
      this.lifecycle.register({ lastJevDecision: structuredClone(record.lastJevDecision), view, runtime, frame: runtime ? await runtime.frame() : Buffer.from(record.frame, 'base64'), history: record.history, stats, navigation: structuredClone(record.navigation), pickups: observePickups(view.state, record.pickups), plan: structuredClone(record.plan) });
    }
    for (const world of this.worlds.values()) this.advanceGoal(world);
    // Do not replay a possibly completed input after a crash. Compare actual engine ticks.
    for (const experiment of this.experiments) {
      const state = this.world(experiment.id).view.state;
      experiment.remaining = Math.max(0, (this.baseline?.tick ?? state.tick) + (this.world(experiment.id).view.trial?.total ?? this.options.horizon) - state.tick);
    }
    if (this.pendingFork && recoverPending) {
      await this.forks.reconcile(recoverPending);
      this.say(this.mainId, 'Recovered the interrupted fork. Existing children are ready to continue.');
    }
    if (this.pendingFork) throw new Error('Interrupted fork requires a runtime reconciliation adapter');
    if (this.experiments.length) this.view.stage = this.experiments.some(e => e.remaining > 0) ? 'exploring' : 'choosing';
    else this.view.stage = 'ready';
    this.checkpointRecovery.reconcileCapture();
    if (this.recovery.pendingRestore) {
      if (!recoverPending) throw new Error('Interrupted rollback requires runtime reconciliation');
      const pending = this.recovery.pendingRestore;
      const runtime = await recoverPending(pending.id);
      if (runtime) await this.installRollback(runtime, pending.pointId);
      else this.recovery.pendingRestore = undefined;
    }
    this.applyLearningPolicy();
    await this.cleanCheckpoints();
    if (this.cleanup.length && !destroyPending) throw new Error('Pending sandbox cleanup requires a runtime cleanup adapter');
    if (destroyPending) await this.lifecycle.collect(destroyPending);
    this.say(this.mainId, 'Reconnected to existing sandboxes. Play is paused.');
    await this.persist(); this.emitView();
  }
  snapshot(): SessionView {
    const main = this.worlds.get(this.mainId), stats = main?.stats;
    return structuredClone({ ...this.view, mainId: this.mainId, busy: this.view.busy || this.lifecycle.busy || this.checkpointRecovery.busy || this.forks.busy,
      recovery: { policy: this.recovery.policy, failures: this.recovery.failures, message: this.recovery.message,
        checkpoints: this.recovery.points.map(p => ({ id: p.id, createdAt: p.createdAt, tick: p.world.state.tick, health: p.world.state.health, kills: p.stats.kills, map: `E${p.world.state.episode}M${p.world.state.map}` })) },
      stats: main && stats ? { kills: stats.kills, items: stats.items, secrets: stats.secrets, levels: stats.levels, seconds: stats.ticks / 35, stalledSeconds: Math.max(0, main.view.state.tick - stats.lastProgressTick) / 35,
        health: main.view.state.health, armor: main.view.state.armor, ammo: main.view.state.ammo, damage: stats.damage, healing: stats.healing,
        ammoSpent: stats.ammoSpent, cells: stats.visited.length, partial: stats.partial,
        attempts: { seconds: this.attempts.ticks / 35, kills: this.attempts.kills, deaths: this.attempts.deaths, rejectedBatches: this.attempts.rejectedBatches, retries: this.attempts.retries, rollbacks: this.attempts.rollbacks, planFailures: this.attempts.planFailures } } : undefined,
      experience: { enabled: this.memoryEnabled, stored: this.memory.records.length, used: this.memoryUsed, capacity: this.memory.capacity, contextLimit: this.memoryPerDecision, evidence: this.memoryEvidence }, worlds: [...this.worlds.values()].map(w => w.view) }); }
  frame(id: string) { return this.world(id).frame; }
  private world(id: string) { return this.lifecycle.world(id); }
  private emitView() { this.emit('change', this.snapshot()); }
  private say(worldId: string, text: string) {
    this.view.commentary.push({ id: ++this.sequence, worldId, text, at: Date.now() });
    this.view.commentary = this.view.commentary.slice(-100);
  }
  private async readWorld(runtime: WorldRuntime, fields: Pick<WorldView, 'generation' | 'role' | 'label'> & { parentId?: string; probability?: number; policyRevision?: WorldView['policyRevision']; learning?: WorldView['learning'] }): Promise<World> {
    const state = await runtime.state(), frame = await runtime.frame();
    return { runtime, frame, history: [state], pickups: observePickups(state, fields.parentId ? this.world(fields.parentId).pickups : undefined), navigation: structuredClone(fields.parentId ? this.world(fields.parentId).navigation : undefined), stats: structuredClone(fields.parentId ? this.world(fields.parentId).stats : initialStats(state)), view: { ...fields, currentAction: fields.role === 'experiment' ? fields.label : undefined, id: runtime.id, state, status: 'paused', controller: 'ai', frameVersion: 1 } };
  }
  private async add(runtime: WorldRuntime, fields: Parameters<Session['readWorld']>[1]) {
    const world = await this.readWorld(runtime, fields);
    this.lifecycle.register(world);
    await this.record?.(world.view, world.frame);
  }
  setPlanningMode(mode: 'plans' | 'actions') { this.rememberOverride({ planningMode: mode }); this.view.planningMode = mode; this.emitView(); }
  private installPlan(world: World, plan: GamePlan, ticks: number, skillsRevision = this.view.skillsRevision ?? 0) {
    world.plan = startPlan(plan, world.view.state, ticks);
    world.plan.guide = this.view.objective;
    world.plan.skillsRevision = skillsRevision;
    if (skillsRevision !== (this.view.skillsRevision ?? 0)) stopPlan(world.plan, "replan", "AI skills updated");
    world.view.plan = planView(world.plan);
    world.view.currentAction = plan.steps[0]!.label;
    world.navigation = undefined;
    this.say(world.view.id, `Plan: ${plan.label}. ${plan.steps.map(s => s.label).join(' → ')}.`);
  }
  private async advancePlan(world: World, remaining: number, signal: AbortSignal): Promise<number> {
    const run = world.plan!, beganRunning = run.status === 'running';
    let elapsed = 0;
    while (elapsed < remaining && !signal.aborted && run.status === 'running') {
      if ((run.skillsRevision ?? 0) !== (this.view.skillsRevision ?? 0)) { stopPlan(run, 'replan', 'AI skills updated'); break; }
      if (this.view.pendingObjective || run.guide && run.guide !== this.view.objective) { stopPlan(run, 'replan', 'AI guide updated'); break; }
      const started = performance.now(), oldStep = run.step;
      let inputs = planInputs(run, world.view.state, world.history, await geometryFor(world.view.state, true, true), this.decisionPolicy(world)?.execution);
      world.navigation = planNavigationMemory(world.navigation, run, oldStep);
      world.view.plan = planView(run);
      if (run.status !== 'running') break;
      world.view.currentAction = run.plan.steps[run.step]!.label;
      if (oldStep !== run.step) this.say(world.view.id, `${run.plan.label}: step ${run.step + 1}/${run.plan.steps.length}, ${world.view.currentAction}.`);
      // Finish collision recovery only within its original movement step.
      // Arrival must yield to the next waypoint, aiming or interaction immediately.
      if (world.navigation?.escape) inputs = ['forward'];
      if (this.control && !inputs.every(i => i === 'left' || i === 'right')) inputs = await this.controlledInputs(world, inputs);
      if (signal.aborted) break;
      world.view.status = 'running';
      await this.refresh(world, await world.runtime!.step({ ticks: 1, inputs }));
      elapsed++;
      this.prepareNextDecision(world, signal);
      await this.pace(signal, started);
    }
    // Record condition/limit transitions at the final frame as well as before
    // the next input. This prevents a completed trial showing an active plan.
    if (!signal.aborted && run.status === 'running') planInputs(run, world.view.state, world.history, await geometryFor(world.view.state, true, true), this.decisionPolicy(world)?.execution);
    world.view.plan = planView(run);
    if (beganRunning && run.status !== 'running') {
      const feedback = failedPlanFeedback(run, world.view.state);
      if (feedback) {
        this.attempts.planFailures++;
        this.recentPlanFailures.push({ worldId: world.view.id, feedback }); this.recentPlanFailures = this.recentPlanFailures.slice(-16);
      }
      this.memory.remember(world.view.id, run.plan.label, run.started, world.view.state);
      this.say(world.view.id, `${run.plan.label}: ${run.reason}.`);
    }
    return elapsed;
  }
  private async controlledInputs(world: World, inputs: Input[]) {
    const previousEscape = world.navigation?.escape;
    const result = await this.control!(world.view.state, inputs, world.navigation ??= {}, this.decisionPolicy(world));
    if (world.navigation.escape && world.navigation.escape !== previousEscape) {
      this.say(world.view.id, `Movement controller: obstacle detected, turning ${world.navigation.escape.turn} toward more clearance.`);
    }
    return result;
  }
  private async refresh(world: World, state: GameState) {
    const before = world.view.state;
    const killsBefore = world.stats.kills;
    advanceStats(world.stats, before, state);
    this.attempts.ticks += Math.max(0, state.tick - before.tick);
    this.attempts.kills += world.stats.kills - killsBefore;
    this.attempts.deaths += Number(before.alive && !state.alive);
    world.pickups = observePickups(state, world.pickups);
    world.view.state = state;
    this.advanceGoal(world);
    if (world.view.role === 'experiment' && this.baseline) world.view.trial = {
      elapsed: state.tick - this.baseline.tick, total: world.view.trial?.total ?? this.options.horizon,
      healthChange: state.health - this.baseline.health, kills: (world.view.trial?.kills ?? 0) + world.stats.kills - killsBefore,
      distance: Math.round(Math.hypot(state.x - this.baseline.x, state.y - this.baseline.y)),
    };
    world.history.push(state);
    world.history = world.history.slice(-10);
    if (world.plan) {
      const previousStep = world.plan.step;
      planInputs(world.plan, state, world.history, await geometryFor(state, true, true), this.decisionPolicy(world)?.execution);
      world.navigation = planNavigationMemory(world.navigation, world.plan, previousStep);
      if (world.plan.step !== previousStep && world.plan.status === 'running') this.say(world.view.id, `${world.plan.plan.label}: step ${world.plan.step + 1}/${world.plan.plan.steps.length}, ${world.plan.plan.steps[world.plan.step]!.label}.`);
      world.view.plan = planView(world.plan);
      if (world.plan.status === 'running') world.view.currentAction = world.plan.plan.steps[world.plan.step]!.label;
    }
    world.frame = await world.runtime!.frame();
    world.view.frameVersion++;
    await this.record?.(world.view, world.frame);
    if (!state.alive) world.view.status = 'ended';
    this.emitView();
  }
  setRecoveryPolicy(policy: RecoveryPolicy) {
    if (typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 10
      || !Number.isInteger(policy.healthLoss) || policy.healthLoss < 1 || policy.healthLoss > 100
      || !Number.isInteger(policy.stallSeconds) || policy.stallSeconds < 5 || policy.stallSeconds > 120) throw new Error('Invalid recovery policy');
    if (policy.enabled && !this.checkpointAdapter) throw new Error('Execution checkpoints are unavailable');
    this.rememberOverride({ recovery: policy });
    this.recovery.policy = { enabled: policy.enabled, maxRetries: policy.maxRetries, healthLoss: policy.healthLoss, stallSeconds: policy.stallSeconds };
    this.emitView();
  }
  private async pausedOperation(operation: () => Promise<void>) {
    await this.pause(); this.requireIdle();
    this.launch(operation); await this.idle();
    if (this.view.error) throw new Error(this.view.error);
  }
  async saveRecoveryCheckpoint() {
    await this.pausedOperation(() => this.capturePoint());
  }
  async rollback(id: string) {
    await this.pausedOperation(() => this.restorePoint(id));
  }
  async deleteCheckpoint(id: string) {
    await this.pausedOperation(() => this.checkpointRecovery.remove(id));
  }
  private shouldCheckpoint(main: World) {
    const last = this.recovery.points.at(-1)!;
    return main.stats.ticks - last.stats.ticks >= 30 * 35 && main.view.state.health >= Math.max(40, last.world.state.health)
      && (main.stats.levels > last.stats.levels || main.stats.kills > last.stats.kills
        || main.stats.visited.length >= last.stats.visited.length + 4);
  }
  private recoveryPoint(main: World): RecoveryPoint {
    if (!main.view.state.alive || main.view.state.phase !== 'level') throw new Error('Checkpoint a living player inside a level');
    const id = randomUUID();
    return { id, reference: `mom-checkpoint-${id}:recovery`, createdAt: Date.now(), world: structuredClone(main.view), history: structuredClone(main.history), stats: structuredClone(main.stats), navigation: structuredClone(main.navigation), pickups: structuredClone(main.pickups), plan: structuredClone(main.plan) };
  }
  private async capturePoint() {
    const point = await this.checkpointRecovery.capture();
    this.recovery.message = `Checkpoint saved at ${(point.world.state.tick / 35).toFixed(1)}s with ${point.world.state.health} health.`;
    this.say(point.world.id, this.recovery.message); this.emitView();
  }
  private cleanCheckpoints() { return this.checkpointRecovery.collect(); }
  private async restorePoint(pointId: string) {
    await this.checkpointRecovery.restore(pointId);
    this.advanceGoal(this.world(this.mainId));
    await this.persist();
    this.announceRollback();
  }
  private async installRollback(runtime: WorldRuntime, pointId: string) {
    await this.checkpointRecovery.recover(runtime, pointId);
    this.advanceGoal(this.world(this.mainId));
    await this.persist();
    this.announceRollback();
  }
  private async attachRollback(runtime: WorldRuntime, point: RecoveryPoint): Promise<World> {
    const state = await runtime.state();
    const { isDeepStrictEqual } = await import('node:util');
    if (!isDeepStrictEqual(state, point.world.state)) throw new Error('Restored execution differs from the saved checkpoint; old run retained');
    const frame = await runtime.frame();
    const world: World = { runtime, frame, history: structuredClone(point.history), stats: structuredClone(point.stats), navigation: structuredClone(point.navigation), pickups: structuredClone(point.pickups), plan: structuredClone(point.plan), view: {
      ...structuredClone(point.world), id: runtime.id, parentId: point.world.id, state,
      generation: point.world.generation + 1, role: 'experiment', status: 'paused', controller: 'ai',
      label: 'restored checkpoint', currentAction: undefined, thinking: false, trial: undefined, score: undefined, probability: undefined,
    } };
    await this.record?.(world.view, frame);
    return world;
  }
  private stageRollback() {
    const view = { directorWorldIds: this.view.directorWorldIds, comparison: this.view.comparison, decision: this.view.decision,
      confidence: this.view.confidence, running: this.view.running, error: this.view.error };
    const failures = this.recovery.failures, rollbacks = this.attempts.rollbacks;
    this.recovery.failures = 0; this.attempts.rollbacks++;
    this.view.directorWorldIds = undefined; this.view.comparison = undefined; this.view.decision = undefined;
    this.view.confidence = undefined; this.view.running = false; this.view.error = undefined;
    return () => { Object.assign(this.view, view); this.recovery.failures = failures; this.attempts.rollbacks = rollbacks; };
  }
  private announceRollback() {
    this.recovery.message = 'Rolled back to the checkpoint. Experience and previous recordings are kept. Paused for review.';
    this.say(this.mainId, this.recovery.message); this.emitView();
  }
  private poorOutcome(world?: World): string | undefined {
    if (!world?.view.state.alive) return 'all futures died';
    const state = world.view.state, before = this.baseline!;
    if (state.map !== before.map || state.episode !== before.episode || state.phase === 'intermission' || state.phase === 'finale') return;
    const checkpoint = this.recovery.points.at(-1)?.world.state;
    const healthBaseline = checkpoint && checkpoint.map === state.map && checkpoint.episode === state.episode ? Math.max(before.health, checkpoint.health) : before.health;
    if (healthBaseline - state.health >= this.recovery.policy.healthLoss) return `lost at least ${this.recovery.policy.healthLoss} health since the checkpoint or trial start`;
    if (state.tick - world.stats.lastProgressTick >= this.recovery.policy.stallSeconds * 35) return `no new area, kill, pickup or health gain for ${this.recovery.policy.stallSeconds}s`;
  }
  private async rejectBatch(signal: AbortSignal) {
    const reason = this.poorOutcome(this.rankExperiments()[0])!;
    this.recovery.failures++; this.attempts.rejectedBatches++;
    if (!this.recovery.policy.enabled || !this.recovery.points.length) {
      // Death in every speculative future is a measured outcome, not a runtime
      // failure. Keep the unchanged source and let the user decide when to retry.
      this.view.running = false;
      await this.select(this.mainId);
      this.view.comparison = undefined;
      this.recovery.message = 'All futures died. Your main session is unchanged. Paused for review; resume to try other approaches or enable checkpoint recovery.';
      this.say(this.mainId, this.recovery.message);
      await this.persist(); this.emitView();
    } else if (this.recovery.failures <= this.recovery.policy.maxRetries) {
      this.attempts.retries++;
      // The unchanged source is the exact retry point. Rotate opening candidates
      // on the next attempt; remembered outcomes can also inform Jev when enabled.
      await this.select(this.mainId);
      this.view.comparison = undefined;
      this.recovery.message = `Rejected batch: ${reason}. Retry ${this.recovery.failures}/${this.recovery.policy.maxRetries} from the same state; opening candidates rotate where alternatives remain.`;
      this.say(this.mainId, this.recovery.message);
      await this.persist(); this.emitView();
    } else if (!signal.aborted) {
      await this.restorePoint(this.recovery.points.at(-1)!.id);
    }
  }

  setMaxFutures(count: number) {
    if (!Number.isInteger(count) || count < 2 || count > 10) throw new Error('Maximum futures must be 2–10');
    this.rememberOverride({ breadth: count });
    this.view.maxFutures = count; this.view.effectiveFutures = count; this.applyLearningPolicy(); this.emitView();
  }
  setTrialDuration(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 35 || ticks > 2100) throw new Error('Trial duration must be 35–2100 game ticks (1–60 seconds)');
    this.rememberOverride({ trialTicks: ticks });
    this.view.trialDurationTicks = ticks;
    this.emitView(); // Each batch captures its own horizon before its first judgment.
  }
  setDecisionInterval(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 7 || ticks > 2100) throw new Error('Decision interval must be 7–2100 game ticks (0.2–60 seconds)');
    this.rememberOverride({ decisionTicks: ticks, decisionIntervalMode: 'fixed' });
    this.view.decisionIntervalMode = 'fixed';
    this.view.decisionIntervalTicks = ticks;
    this.emitView(); // In-flight actions retain their boundary; subsequent judgments use this value.
  }
  setDecisionIntervalMode(mode: 'fixed' | 'trial') {
    if (mode !== 'fixed' && mode !== 'trial') throw new Error('Invalid decision interval mode');
    this.rememberOverride({ decisionIntervalMode: mode });
    this.view.decisionIntervalMode = mode; this.emitView();
  }
  private decisionTicks(horizon = this.view.trialDurationTicks ?? this.options.horizon): number {
    // Existing plan sessions keep their completion/horizon behavior until edited.
    const mode = this.view.decisionIntervalMode ?? 'fixed';
    return mode === 'trial' ? horizon : this.view.decisionIntervalTicks ?? 35;
  }
  private planDuration(horizon: number, actionTicks: number): number {
    return this.view.decisionIntervalMode === 'fixed' ? Math.min(horizon, actionTicks) : horizon;
  }
  setWinnerDelay(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Winner delay must be between 0 and 60 seconds');
    this.rememberOverride({ winnerDelaySeconds: seconds });
    this.view.winnerDelaySeconds = seconds;
    if (this.view.reviewEndsAt !== undefined) this.view.reviewEndsAt = Date.now() + seconds * 1000;
    this.emitView();
  }
  useExperience(enabled: boolean) {
    this.rememberOverride({ memory: { enabled } });
    this.memoryEnabled = enabled; this.memoryUsed = 0; this.memoryEvidence = [];
    this.say(this.mainId, enabled ? 'Experience enabled. Relevant observed attempts will inform the next decision.' : 'Experience disabled for future decisions. Recorded attempts remain available.');
    this.emitView();
  }
  clearExperience() { this.requireContextWritable(); for (const slot of this.nextDecisions.values()) slot.cancel(); this.memory.records = []; this.memoryUsed = 0; this.memoryEvidence = []; this.emitView(); }
  setForkThreshold(threshold: number) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Fork confidence must be between 0 and 1');
    this.rememberOverride({ forkThreshold: threshold });
    this.view.forkThreshold = threshold; this.emitView();
  }
  configureMemory(capacity: number, perDecision: number) {
    if (!Number.isInteger(perDecision) || perDecision < 1 || perDecision > 8) throw new Error('Decision memory limit must be 1–8 attempts');
    if (!Number.isInteger(capacity) || capacity < 8 || capacity > 1024) throw new Error('Memory capacity must be 8–1024');
    this.rememberOverride({ memory: { capacity, perDecision } });
    this.memory.setCapacity(capacity); this.memoryPerDecision = perDecision; this.emitView();
  }
  saveSkill(input: Omit<AiSkill, 'id'>, id?: string) {
    const values = skillInput.parse(input), skills = this.view.skills ?? [];
    if (id && !skills.some(s => s.id === id)) throw new Error('Skill not found');
    const next = { ...values, id: id ?? randomUUID() };
    this.replaceSkills(id ? skills.map(s => s.id === id ? next : s) : [...skills, next]);
  }
  toggleSkill(id: string, enabled: boolean) {
    const skill = this.view.skills?.find(s => s.id === id);
    if (!skill) throw new Error('Skill not found');
    this.saveSkill({ ...skill, enabled }, id);
  }
  deleteSkill(id: string) {
    if (!this.view.skills?.some(s => s.id === id)) throw new Error('Skill not found');
    this.replaceSkills(this.view.skills.filter(s => s.id !== id));
  }
  private replaceSkills(skills: AiSkill[]) {
    this.requireContextWritable();
    const next = validateSkills(skills);
    const changed = JSON.stringify(activeSkills(this.view.skills ?? [])) !== JSON.stringify(activeSkills(next));
    this.view.skills = next;
    if (!changed) { this.emitView(); return; }
    this.view.skillsRevision = (this.view.skillsRevision ?? 0) + 1;
    for (const world of this.worlds.values()) if (world.plan?.status === 'running') {
      stopPlan(world.plan, 'replan', 'AI skills updated'); world.view.plan = planView(world.plan);
    }
    for (const experiment of this.experiments) experiment.nextDecisionTick = this.world(experiment.id).view.state.tick;
    this.say(this.mainId, 'AI skills updated. New decisions will use the enabled skills.');
    this.emitView();
  }
  private experiences(state: GameState) { return this.memoryEnabled ? this.memory.relevant(state, this.memoryPerDecision) : []; }
  private applyGuide() {
    if (!this.view.pendingObjective) return;
    this.view.objective = this.view.pendingObjective; this.view.pendingObjective = undefined;
    for (const world of this.worlds.values()) if (world.plan?.status === 'running') {
      stopPlan(world.plan, 'replan', 'AI guide updated'); world.view.plan = planView(world.plan);
    }
    for (const world of this.worlds.values()) this.advanceGoal(world);
    this.say(this.mainId, `New objective: ${this.view.objective}`);
  }
  private decisionPolicy(world: World) {
    const reference = world.view.policyRevision;
    if (!reference) return undefined;
    const policy = this.policies.get(reference.version);
    if (!policy) throw new Error('Plan execution requires its recorded policy revision');
    return policy.policy.values;
  }
  private controlPolicy(): DoomPolicy {
    const learned = this.revisions ? learningDoomPolicy(this.revisions.current().artifact, this.userOverrides).policy.values : undefined;
    const outcomeWeights = learned?.outcomeWeights, execution = learned?.execution, motor = learned?.motor;
    return { ...(outcomeWeights ? { outcomeWeights } : {}), ...(execution ? { execution } : {}), ...(motor ? { motor } : {}), forkThreshold: this.view.forkThreshold ?? this.options.threshold, breadth: this.view.effectiveFutures ?? this.view.maxFutures ?? this.options.branches,
      trialTicks: this.view.trialDurationTicks ?? this.options.horizon, decisionTicks: this.view.decisionIntervalTicks ?? 35,
      ...(this.view.decisionIntervalMode ? { decisionIntervalMode: this.view.decisionIntervalMode } : {}),
      planningMode: this.view.planningMode ?? 'plans', winnerDelaySeconds: this.view.winnerDelaySeconds ?? 0,
      memory: { enabled: this.memoryEnabled, capacity: this.memory.capacity, perDecision: this.memoryPerDecision }, recovery: this.recovery.policy };
  }
  /** User guide and edits are external to mutable learning artifacts. */
  supervisorContext(): VersionRef {
    return contentRevision('doom-user-context', { objective: this.view.pendingObjective ?? this.view.objective,
      skills: activeSkills(this.view.skills ?? []), binding: this.revisions?.identity ?? null,
      overrides: this.revisions ? this.userOverrides : this.controlPolicy() });
  }
  learningPolicy(): DoomPolicy { return structuredClone(this.controlPolicy()); }
  /** Call from the controller's compatibility port before publishing an activation. */
  validateLearningRevision(artifact: LearningRevision<DoomPolicy>): void {
    if (this.revisions && !isDeepStrictEqual(artifact.adapter, this.revisions.adapter)) throw new Error('Incompatible Doom learning adapter');
    const policy = learningDoomPolicy(artifact, this.userOverrides).policy.values;
    if (policy.recovery.enabled && !this.checkpointAdapter) throw new Error('Learning policy requires execution checkpoints');
  }
  private requireContextWritable() {
    if (this.changingRevision) throw new Error('Learning revision publication is in progress');
    if (this.learningError) throw this.learningError;
  }
  private rememberOverride(patch: PolicyPatch<DoomPolicy>) {
    this.requireContextWritable();
    if (!this.revisions) return;
    const next = { ...this.userOverrides, ...patch,
      ...(patch.memory ? { memory: { ...this.userOverrides.memory, ...patch.memory } } : {}),
      ...(patch.recovery ? { recovery: { ...this.userOverrides.recovery, ...patch.recovery } } : {}) };
    learningDoomPolicy(this.revisions.current().artifact, next);
    this.userOverrides = next;
  }
  private applyLearningPolicy() {
    if (this.learningError) throw this.learningError;
    if (!this.revisions) return;
    const { artifact, activation } = this.revisions.current(); doomLearningProvenance(this.revisions, activation, artifact);
    this.validateLearningRevision(artifact);
    const policy = cappedLearningDoomPolicy(artifact, this.userOverrides, this.view.maxFutures ?? this.options.branches).policy.values;
    this.view.forkThreshold = policy.forkThreshold; this.view.effectiveFutures = policy.breadth;
    this.view.trialDurationTicks = policy.trialTicks; this.view.decisionIntervalTicks = policy.decisionTicks;
    this.view.decisionIntervalMode = policy.decisionIntervalMode;
    this.view.planningMode = policy.planningMode; this.view.winnerDelaySeconds = policy.winnerDelaySeconds;
    this.memoryEnabled = policy.memory.enabled; this.memoryPerDecision = policy.memory.perDecision;
    this.memory.setCapacity(policy.memory.capacity); this.recovery.policy = { ...policy.recovery };
  }
  /** Activation is refused while inputs, a plan, a comparison or manual control are unresolved. */
  async revisionBoundary<T>(work: () => Promise<T>): Promise<T> {
    const inOwnedTurn = this.revisionTurn.getStore() === true;
    if (inOwnedTurn) this.requireContextWritable(); else this.requireIdle();
    if (this.experiments.length || this.view.manualChoiceRequired) throw new Error('Resolve the active Doom comparison before changing learning revision');
    if ([...this.worlds.values()].some(world => world.view.controller === 'human')) throw new Error('Return control to AI before changing learning revision');
    if (this.worlds.get(this.mainId)?.plan?.status === 'running') throw new Error('Finish the active Doom plan before changing learning revision');
    this.changingRevision = true;
    try {
      let result!: T;
      if (inOwnedTurn) { result = await work(); this.applyLearningPolicy(); }
      else await this.execution.run(async () => { result = await work(); this.applyLearningPolicy(); });
      return result;
    } finally { this.changingRevision = false; this.emitView(); }
  }
  /** Explicitly adopt a controller whose baseline matches an existing paused session. */
  async adoptLearning(binding: DoomLearningBinding): Promise<void> {
    if (this.revisions) throw new Error('Doom session already has a learning binding');
    if (!this.save) throw new Error('Persistence is required before adopting a learning binding');
    const policy = learningDoomPolicy(binding.current().artifact, {}).policy.values;
    if (!isDeepStrictEqual(policy, this.controlPolicy())) throw new Error('Learning baseline must preserve the current Doom controls');
    await this.revisionBoundary(async () => {
      this.revisions = binding;
      try { await this.persist(); }
      catch (error) {
        this.learningError = new Error('Doom learning adoption failed; reopen authoritative storage', { cause: error });
        throw this.learningError;
      }
    });
  }
  private capturePolicy(actionTicks = this.view.decisionIntervalTicks ?? 35, horizon = this.view.trialDurationTicks ?? this.options.horizon,
    learned = this.revisions?.current().artifact): DoomPolicyRecord {
    const profile = { forkThreshold: this.options.threshold, breadth: this.options.branches, trialTicks: this.options.horizon };
    const record = learned ? cappedLearningDoomPolicy(learned, { ...this.userOverrides, trialTicks: horizon, decisionTicks: actionTicks }, this.view.maxFutures ?? this.options.branches)
      : doomPolicy(profile, { ...this.controlPolicy(), trialTicks: horizon, decisionTicks: actionTicks });
    this.policies.set(record.revision.version, record);
    return record;
  }
  private pinnedLearning(world: World) {
    return this.revisions ? world.view.role === 'experiment' && world.view.learning
      ? { activation: world.view.learning.activation, artifact: this.revisions.resolve(world.view.learning.activation) } : this.revisions.current() : undefined;
  }
  private goalFrame(world: World): GoalFrame {
    const state = world.view.state;
    return { scope: { id: this.goalScopeId, version: `E${state.episode}M${state.map}` },
      context: contentRevision('doom-goal-context', { objective: this.view.pendingObjective ?? this.view.objective, skills: activeSkills(this.view.skills ?? []) }),
      source: contentRevision('doom-goal-strategy', this.pinnedLearning(world)?.activation ?? { builtin: 1 }),
      clock: { unit: 'doom-ticks', value: state.tick } };
  }
  private advanceGoal(world: World): void {
    const goal = world.view.temporaryGoal;
    if (!goal || goal.record.status !== 'active') return;
    world.view.temporaryGoal = advanceDoomTemporaryGoal(goal, this.goalFrame(world), world.view.state);
    if (world.view.temporaryGoal.record.status !== 'active' && world.plan?.status === 'running') {
      stopPlan(world.plan, 'replan', `Temporary goal ${world.view.temporaryGoal.record.status}`);
      world.view.plan = planView(world.plan);
    }
  }
  private decisionKey(world: World, actionTicks: number, planTicks: number): string {
    return JSON.stringify({ objective: this.view.objective, pending: this.view.pendingObjective,
      skills: this.view.skillsRevision ?? 0, controls: this.controlPolicy(), learning: this.pinnedLearning(world)?.activation,
      actionTicks, planTicks });
  }
  private captureQuestion(world: World, actionTicks: number, planTicks: number, ahead = false): DecisionQuestion {
    this.applyGuide();
    this.advanceGoal(world);
    const pinned = this.pinnedLearning(world);
    const policy = this.capturePolicy(actionTicks, planTicks, pinned?.artifact);
    const state = structuredClone(world.view.state), experience = this.experiences(state);
    const run = world.plan;
    const context: DecisionContext = structuredClone({
      temporaryGoal: { frame: this.goalFrame(world), current: world.view.temporaryGoal },
      experiencePool: policy.policy.values.memory.enabled ? this.memory.records : [],
      previousPlan: previousPlanFeedback(run, state), policy: policy.policy.values,
      skills: this.view.skills ?? [], previousAction: world.view.currentAction,
      planTicks: policy.policy.values.planningMode === 'plans' ? planTicks : undefined,
      stats: decisionStatistics(state, world.stats), visited: world.stats.visited, pickups: world.pickups,
      ...(ahead && run ? { planningAhead: { plan: run.plan.label, target: run.plan.steps.at(-1)!.target,
        remainingTicks: Math.max(0, run.untilTick - state.tick) } } : {}),
    });
    return { key: this.decisionKey(world, actionTicks, planTicks), state, history: structuredClone(world.history),
      objective: this.view.objective, skillsRevision: this.view.skillsRevision ?? 0, experience, policy, context, actionTicks,
      learning: pinned ? doomLearningProvenance(this.revisions!, pinned.activation, pinned.artifact) : undefined,
      model: pinned ? this.revisions!.model(pinned.artifact) : this.decisionMaker };
  }
  private async answerQuestion(question: DecisionQuestion, signal: AbortSignal): Promise<DecisionAnswer> {
    const { state, objective, history, model, experience, actionTicks, context, policy, skillsRevision, learning } = question;
    const observedTick = state.tick;
    const decision = await model.decide(state, objective, history, signal, experience, actionTicks, context);
    return { observedTick, decision, experience: decision.selectedExperience ?? experience, policy, skillsRevision, learning };
  }
  private prepareNextDecision(world: World, signal: AbortSignal): void {
    const pending = this.nextDecisions.get(world.view.id);
    if (pending) {
      // Cleanup can overlap the remaining plan instead of starting at its boundary.
      // Keep the slot owned: ask/pause still join it, and no replacement call is
      // admitted every frame when combat repeatedly changes the observations.
      if (pending.invalidate(question => !this.view.pendingObjective && question.objective === this.view.objective
        && question.skillsRevision === (this.view.skillsRevision ?? 0)
        && decisionStateIsCurrent(question.state, world.view.state, world.plan))) {
        this.emit('decision-prefetch-cancelled', { worldId: world.view.id, tick: world.view.state.tick });
      }
      return;
    }
    const run = world.plan, left = run ? run.untilTick - world.view.state.tick : 0;
    const measured = this.decisionLatency.get(world.view.id) ?? this.view.decision?.latencyMs ?? 600;
    const lead = this.options.paceMs > 0 ? Math.min(decisionLeadTicks, Math.max(4, Math.ceil((measured + 75) / this.options.paceMs))) : decisionLeadTicks;
    if (!this.view.running || this.view.planningMode !== 'plans' || !run || run.status !== 'running'
      || left <= 0 || left > lead || this.view.pendingObjective) return;
    const trialLeft = world.view.role === 'experiment' && this.baseline && world.view.trial
      ? this.baseline.tick + world.view.trial.total - run.untilTick : 0;
    const horizon = trialLeft > 0 ? trialLeft : this.view.trialDurationTicks ?? this.options.horizon;
    const actionTicks = Math.min(this.decisionTicks(trialLeft > 0 ? world.view.trial!.total : horizon), horizon);
    const question = this.captureQuestion(world, actionTicks, horizon, true);
    const slot = new DecisionPrefetch<DecisionQuestion, DecisionAnswer>();
    if (slot.start(question, current => this.answerQuestion(question, current), signal)) this.nextDecisions.set(world.view.id, slot);
  }
  private async discardNextDecisions(except?: string): Promise<void> {
    const entries = [...this.nextDecisions].filter(([id]) => id !== except);
    for (const [, slot] of entries) slot.cancel();
    await Promise.all(entries.map(async ([id, slot]) => {
      await slot.discard();
      if (this.nextDecisions.get(id) === slot) this.nextDecisions.delete(id);
    }));
  }
  private async ask(world: World, signal: AbortSignal, actionTicks: number, planTicks: number): Promise<DecisionAnswer> {
    const started = performance.now(), slot = this.nextDecisions.get(world.view.id);
    let result = await slot?.take((question, answer) => {
      const instructionsCurrent = question.key === this.decisionKey(world, actionTicks, planTicks);
      const stateCurrent = decisionStateIsCurrent(question.state, world.view.state, world.plan, answer?.decision.plans?.candidates);
      this.emit('decision-prefetch', { worldId: world.view.id, instructionsCurrent, stateCurrent,
        ageTicks: world.view.state.tick - question.state.tick, displacement: Math.hypot(world.view.state.x - question.state.x, world.view.state.y - question.state.y),
        planStatus: world.plan?.status, factChanges: decisionFactChanges(question.state, world.view.state), changed: Object.keys(question.state).filter(key => !isDeepStrictEqual(question.state[key as keyof GameState], world.view.state[key as keyof GameState])) });
      const goal = answer?.decision.temporaryGoal ?? question.context.temporaryGoal?.current;
      const goalCurrent = !goal || goal.record.status !== 'active' || advanceDoomTemporaryGoal(goal, this.goalFrame(world), world.view.state).record.status === 'active';
      return instructionsCurrent && stateCurrent && goalCurrent;
    }, signal);
    if (slot) this.nextDecisions.delete(world.view.id);
    // Only absolute-target conditional plans may be reused after player movement.
    if (!result?.decision.plans) result = undefined;
    const prefetched = Boolean(result);
    if (!result) {
      const fresh = await decideCurrent({
        capture: () => this.captureQuestion(world, actionTicks, planTicks),
        decide: (question, current) => this.answerQuestion(question, current),
        isCurrent: question => !this.view.pendingObjective && question.objective === this.view.objective
          && question.skillsRevision === (this.view.skillsRevision ?? 0),
      }, signal);
      result = fresh.result;
    }
    result.decision = { ...result.decision, prefetched, waitMs: performance.now() - started };
    world.view.decisionTiming = { id: randomUUID(), consumedAt: Date.now(), sourceTick: result.observedTick, consumedTick: world.view.state.tick,
      requestMs: result.decision.latencyMs, waitMs: result.decision.waitMs!, prefetched,
      ...(result.decision.timings ? { stages: structuredClone(result.decision.timings) } : {}) };
    if (result.decision.temporaryGoal) {
      world.view.temporaryGoal = advanceDoomTemporaryGoal(result.decision.temporaryGoal, this.goalFrame(world), world.view.state);
      await this.persist();
    }
    world.lastJevDecision = structuredClone(result.decision.jevTrace);
    this.decisionLatency.set(world.view.id, result.decision.latencyMs);
    world.view.policyRevision = result.policy.revision; world.view.learning = result.learning;
    world.view.decisionOptions = decisionOptionsView(result.decision, result.decision.evidence?.stats.current.tick ?? world.view.state.tick, world.view.decisionOptions);
    return result;
  }

  async reconcileFork(recover: (id: string) => Promise<WorldRuntime | undefined>) {
    if (!this.pendingFork) return;
    if (this.active || this.lifecycle.busy || this.checkpointRecovery.busy || this.forks.busy || this.view.running) throw new Error('Pause before reconciling a fork');
    const recovery = this.forks.reconcile(recover);
    this.emitView();
    try {
      await recovery;
      this.view.stage = this.experiments.length ? this.experiments.some(experiment => experiment.remaining > 0) ? 'exploring' : 'choosing' : 'ready';
      this.view.error = undefined; this.failure = undefined;
      this.say(this.mainId, 'Reconciled the interrupted fork. Existing children are ready to continue.');
      await this.persist();
    } finally { this.emitView(); }
  }

  queueObjective(text: string) {
    this.requireContextWritable();
    if (!text.trim() || text.length > 1000) throw new Error('Direction must contain 1–1000 characters');
    this.view.pendingObjective = text.trim();
    this.say(this.mainId, 'Direction queued for the next decision.');
    this.emitView();
  }
  resume() {
    this.requireIdle();
    const human = [...this.worlds.values()].find(w => w.view.controller === 'human');
    if (human) { if (!human.view.state.alive) throw new Error('This world has ended'); human.view.status = 'running'; this.emitView(); return; }
    if (!this.world(this.mainId).view.state.alive) throw new Error('Main session has ended');
    if (this.view.manualChoiceRequired) throw new Error('Choose which world to continue after manual play');
    this.view.running = true;
    this.launch(async signal => { while (!signal.aborted && this.view.running) await this.cycle(signal, false); });
  }
  step() {
    this.requireIdle();
    if ([...this.worlds.values()].some(w => w.view.controller === 'human')) throw new Error('Return control to AI first');
    if (this.view.manualChoiceRequired) throw new Error('Choose which world to continue after manual play');
    this.launch(signal => this.cycle(signal, true));
  }
  async finishRecordingReset(clear: (id: string) => Promise<void>) {
    if (!this.recordingResetTo) return;
    await clear(this.recordingResetTo);
    this.policies.clear(); // The explicit reset has removed the old replay history.
    const main = this.world(this.mainId);
    await this.record?.(main.view, main.frame);
    await this.retainRecording?.(main.view.id);
    this.recordingResetTo = undefined;
    await this.persist();
  }
  async restart(create: () => Promise<WorldRuntime>, clear: (id: string) => Promise<void>) {
    await this.pause(); this.requireIdle();
    this.launch(async () => {
      // Build and read the replacement before discarding anything from this run.
      const runtime = await create();
      let state: GameState, frame: Buffer;
      try { state = await runtime.state(); frame = await runtime.frame(); }
      catch (error) { await runtime.destroy(); throw error; }
      const old = { goalScopeId: this.goalScopeId, worlds: this.worlds, mainId: this.mainId, view: this.view, memory: this.memory, memoryUsed: this.memoryUsed,
        memoryEvidence: this.memoryEvidence, experiments: this.experiments, baseline: this.baseline,
        priority: this.priority, sequence: this.sequence, cleanup: this.cleanup, recovery: this.recovery, attempts: this.attempts, recentPlanFailures: this.recentPlanFailures };
      this.worlds = new Map([[runtime.id, { runtime, frame, history: [state], stats: initialStats(state), view: {
        id: runtime.id, generation: 0, role: 'main', label: 'main session', status: 'paused',
        controller: 'ai', frameVersion: 1, state,
      } }]]);
      this.mainId = runtime.id;
      this.goalScopeId = randomUUID();
      this.view = { worlds: [], running: false, busy: true, stage: 'ready',
        skills: old.view.skills, skillsRevision: old.view.skillsRevision, forkThreshold: old.view.forkThreshold, maxFutures: old.view.maxFutures, planningMode: old.view.planningMode, winnerDelaySeconds: old.view.winnerDelaySeconds, decisionIntervalTicks: old.view.decisionIntervalTicks, decisionIntervalMode: old.view.decisionIntervalMode, trialDurationTicks: old.view.trialDurationTicks, objective: old.view.pendingObjective ?? old.view.objective, commentary: [] };
      this.recovery = { ...newRecovery(), policy: old.recovery.policy, cleanup: [...old.recovery.cleanup, ...old.recovery.points.map(p => p.reference)] };
      this.attempts = newAttempts(); this.recentPlanFailures = [];
      this.memory = new ExperienceMemory(old.memory.capacity); this.memoryUsed = 0; this.memoryEvidence = [];
      this.experiments = []; this.baseline = undefined; this.priority = 'exploration'; this.sequence = 0;
      this.cleanup = [...old.cleanup, ...[...old.worlds.values()].flatMap(w => w.runtime ? [{ id: w.runtime.id, identity: w.runtime.identity }] : [])];
      this.recordingResetTo = runtime.id;
      try { await this.persist(); }
      catch (error) {
        Object.assign(this, old); this.recordingResetTo = undefined;
        await runtime.destroy(); throw error;
      }
      // The committed marker makes interrupted cache cleanup repeatable at boot.
      await this.finishRecordingReset(clear);
      await this.cleanCheckpoints();
      await Promise.allSettled([...old.worlds.values()].map(async world => {
        if (!world.runtime) return;
        await world.runtime.destroy();
        this.cleanup = this.cleanup.filter(c => c.identity !== world.runtime!.identity);
      }));
      this.say(runtime.id, 'New game ready. Recordings and learned attempts were cleared.');
      await this.persist(); this.emitView();
    });
    await this.idle();
    if (this.view.error) throw new Error(this.view.error);
  }
  private requireIdle() { if (this.learningError) throw this.learningError; if (this.recovery.pendingRestore || this.recovery.pendingCapture) throw new Error('Reconcile the interrupted checkpoint operation by restarting the backend'); if (this.recordingResetTo) throw new Error('Restart cleanup is incomplete; restart the backend to finish it'); if (this.pendingFork) throw new Error('Reconcile the interrupted fork first'); if (this.active || this.lifecycle.busy || this.checkpointRecovery.busy || this.forks.busy || this.view.running) throw new Error('Pause before this operation'); }
  private launch(work: (signal: AbortSignal) => Promise<void>) {
    this.failure = undefined;
    this.view.busy = true;
    this.view.error = undefined;
    this.execution.run(async signal => {
      try {
        try { if (!signal.aborted) await work(signal); }
        finally { await this.discardNextDecisions(); await this.lifecycle.join(); }
      }
      catch (error) {
        if (!signal.aborted) {
          this.failure = error;
          this.view.error = error instanceof Error ? error.message : 'Session error';
          this.view.stage = 'error';
          this.say(this.mainId, this.view.error);
        }
      } finally {
        this.view.running = false;
        this.view.busy = false;
        for (const w of this.worlds.values()) if (w.view.status === 'running' && w.view.controller === 'ai') w.view.status = 'paused';
        this.emitView();
      }
    });
    this.emitView();
  }
  async idle() { await this.execution.join(); }
  async pause() {
    this.view.running = false;
    this.view.reviewEndsAt = undefined;
    this.execution.cancel();
    for (const world of this.worlds.values()) if (world.view.status === 'running') world.view.status = 'paused';
    await this.execution.join(); // Fence dispatched inputs before acknowledging pause.
    await this.lifecycle.join();
    await this.checkpointRecovery.join();
    await this.forks.join();
    await this.persist();
    this.emitView();
  }
  async takeover(id: string) {
    await this.pause();
    const world = this.world(id);
    if (world.view.role === 'archived' || !world.view.state.alive) throw new Error('This world is view-only');
    for (const w of this.worlds.values()) w.view.controller = 'ai';
    world.plan = undefined; world.view.plan = undefined; world.navigation = undefined;
    world.view.controller = 'human';
    world.view.status = 'running';
    if (this.experiments.length) this.view.manualChoiceRequired = true;
    this.say(id, 'You have control. Automatic exploration is paused.');
    this.emitView();
  }
  release(id: string) {
    this.requireIdle();
    const world = this.world(id);
    if (world.view.controller !== 'human') throw new Error('You do not control this world');
    world.view.controller = 'ai';
    world.view.status = world.view.state.alive ? 'paused' : 'ended';
    // Manual edits invalidate fair comparisons. Keep children, require explicit promotion.
    if (this.experiments.length) this.view.stage = 'choosing';
    this.say(id, 'Control returned to AI. Play remains paused.');
    this.emitView();
  }
  async input(id: string, inputs: Input[]) {
    this.requireIdle();
    const world = this.world(id);
    if (world.view.controller !== 'human' || world.view.status !== 'running' || world.view.role === 'archived' || !world.view.state.alive) throw new Error('Take control of a live world first');
    this.launch(async () => { await this.refresh(world, await world.runtime!.step({ ticks: this.options.frameTicks ?? 7, inputs })); });
    await this.active;
  }
  async promote(id: string) {
    this.requireIdle();
    if ((!this.experiments.length || this.world(id).view.role === 'archived') || !this.world(id).view.state.alive) throw new Error('Select a live experiment');
    this.recovery.failures = 0;
    await this.select(id);
  }
  private stageSelection(id: string) {
    const previous = { comparison: this.view.comparison, manualChoiceRequired: this.view.manualChoiceRequired, stage: this.view.stage };
    const experiments = this.experiments, baseline = this.baseline;
    if (this.view.comparison) this.view.comparison = { ...this.view.comparison, bestId: id, selected: true };
    this.experiments = [];
    this.view.manualChoiceRequired = false;
    this.baseline = undefined;
    this.view.stage = 'ready';
    return () => { Object.assign(this.view, previous); this.experiments = experiments; this.baseline = baseline; };
  }
  private async select(id: string) {
    for (const [worldId, slot] of this.nextDecisions) if (worldId !== id) slot.cancel();
    for (const worldId of this.decisionLatency.keys()) if (worldId !== id) this.decisionLatency.delete(worldId);
    const promotion = this.lifecycle.promote(id, { cleanup: this.view.running ? 'background' : 'wait' });
    this.emitView();
    try {
      await promotion;
      this.say(id, 'This world is now the main session. Other worlds are archived.');
      await this.persist();
    } finally { this.emitView(); }
  }
  private async cycle(signal: AbortSignal, manual: boolean) {
    if (!signal.aborted) await this.applyQueuedLearningActivation();
    if (signal.aborted) return;
    this.applyLearningPolicy();
    const main = this.world(this.mainId);
    if (!this.experiments.length && main.view.state.phase === 'intermission' && main.view.controller === 'ai') {
      await this.advanceIntermission(main, signal);
    } else if (await this.learning.cycle(signal, manual) === 'stopped') this.view.running = false;
    // A manual promotion or recovery rollback can end at a safe paused boundary.
    // There will be no next cycle to service a queued checkpoint/revision there.
    if (!signal.aborted && !this.view.running) await this.applyQueuedLearningActivation();
  }
  private async advanceIntermission(world: World, signal: AbortSignal) {
    await this.discardNextDecisions();
    world.plan = undefined; world.view.plan = undefined; world.navigation = undefined;
    world.view.decisionOptions = undefined; world.view.thinking = false;
    if (world.view.currentAction !== 'continue to the next level') this.say(world.view.id, 'Level complete. Continuing through the results screen.');
    world.view.currentAction = 'continue to the next level';
    this.view.stage = 'acting'; this.view.decision = undefined;
    // Intermission uses attack-button edges to advance its counters/screens.
    // Send real release/press ticks, bypassing the in-level shooting guard.
    // One bounded second per cycle keeps pause and persistence responsive.
    for (let tick = 0; tick < 35 && !signal.aborted && world.view.state.phase === 'intermission'; tick++) {
      const started = performance.now(); world.view.status = 'running';
      await this.refresh(world, await world.runtime!.step({ ticks: 1, inputs: world.view.state.tick % 14 === 0 ? ['fire'] : [] }));
      await this.pace(signal, started);
    }
    world.view.status = world.view.state.alive ? 'paused' : 'ended';
    this.view.stage = 'ready'; await this.persist(); this.emitView();
  }
  private async judge(main: World, limits: DoomLoopLimits, signal: AbortSignal): Promise<DoomJudgment> {
    const { decision, experience: experiences, policy, skillsRevision, learning } = await this.ask(main, signal, limits.actionTicks, limits.horizon);
    const candidates: DoomCandidate[] = decision.plans
      ? decision.plans.candidates.map(plan => ({ action: 'advance', label: plan.label, probability: plan.probability, plan }))
      : (Object.keys(actions) as ActionId[]).filter(id => !decision.perception?.excludedActions.includes(id)).map(action => ({ action, label: actions[action].label, probability: decision.probabilities[action] }));
    return { confidence: decision.confidence, candidates, data: { decision, experiences, policy, skillsRevision, learning } };
  }
  private recordDecision(main: World, judgment: DoomJudgment, routing: RoutedJudgment<DoomCandidate>, limits: DoomLoopLimits) {
    const { decision, experiences } = judgment.data;
    this.memoryUsed = decision.experienceUsed ?? 0;
    this.memoryEvidence = experiences.slice(0, this.memoryUsed).map(e => ({ action: e.action, ...e.result }));
    this.view.confidence = decision.confidence; this.view.model = decision.model; this.priority = decision.priority;
    const threshold = this.view.forkThreshold ?? this.options.threshold;
    const { mode, ranked: allCandidates, trials: candidates } = routing;
    const selectedPlan = decision.plans?.candidates.find(p => p.id === decision.plans!.selected);
    this.view.routing ??= { direct: 0, uncertain: 0, manual: 0 };
    this.view.routing[mode] = (this.view.routing[mode] ?? 0) + 1;
    this.view.comparison = undefined;
    this.view.decision = { preparation: decision.preparation, learning: judgment.data.learning, policyRevision: judgment.data.policy.revision, routingPolicyRevision: this.capturePolicy(limits.actionTicks, limits.horizon).revision, candidateCount: judgment.candidates.length, futureLimit: limits.breadth, kind: decision.plans ? 'plan' : 'action', action: selectedPlan?.label ?? actions[decision.action].label, mode, threshold, evidence: decision.evidence,
      perception: decision.perception, sourceId: main.view.id, tick: main.view.state.tick, latencyMs: decision.latencyMs, waitMs: decision.waitMs, prefetched: decision.prefetched,
      preferences: allCandidates.map(candidate => ({ action: candidate.label, probability: candidate.probability, tested: mode !== 'direct' && candidates.includes(candidate) })),
    };
  }
  private async reviewWinner(signal: AbortSignal) {
    const reviewMs = (this.view.winnerDelaySeconds ?? 0) * 1000;
    if (reviewMs <= 0) return;
    this.view.reviewEndsAt = Date.now() + reviewMs;
    this.emitView();
    try {
      while (!signal.aborted && this.view.reviewEndsAt && this.view.reviewEndsAt > Date.now()) {
        await this.waitFor(Math.min(100, this.view.reviewEndsAt - Date.now()), signal);
      }
    } finally { this.view.reviewEndsAt = undefined; }
  }
  private async createComparison(main: World, candidates: DoomCandidate[], judgment: DoomJudgment, limits: DoomLoopLimits, signal: AbortSignal) {
    await this.discardNextDecisions(); // Join unused speculative calls before admitting another batch.
    const { decision } = judgment.data;
    const { horizon, actionTicks } = limits;
    const { mode, threshold } = this.view.decision!;
    this.say(main.view.id, mode === 'manual' ? 'You requested a comparison. Testing alternate approaches from this moment.' : mode === 'stalled' ? 'No useful progress for 10 game seconds. Testing alternatives despite model confidence.' : `Jev confidence ${Math.round(decision.confidence * 100)}%, below the ${Math.round(threshold * 100)}% threshold. Testing alternate actions.`);
    this.emitView();
    const generation = main.view.generation + 1;
    const batchId = randomUUID().replaceAll('-', '').slice(0, 16);
    if (this.vmSettings) {
      const overview = await this.vmOverview();
      const source = overview.worlds.find(w => w.id === main.view.id)!;
      assertVmBudget([...overview.worlds.map(w => w.resources), ...candidates.map(() => source.resources)], overview.settings.budget);
    }
    const ids = candidates.map((_, i) => `${main.view.id.split('-g')[0]}-g${generation}-${batchId}-${i}`);
    await this.forks.create({ learning: judgment.data.learning, policyRevision: judgment.data.policy.revision, parentId: main.view.id, ids,
      actions: candidates.map(candidate => candidate.action), plans: decision.plans ? candidates.map(candidate => candidate.plan!) : undefined,
      candidates: candidates.map(candidate => ({ label: candidate.label, probability: candidate.probability })),
      skillsRevision: judgment.data.skillsRevision, horizon, actionTicks, baseline: structuredClone(main.view.state),
    }, signal);
  }
  private async attachFork(runtime: WorldRuntime, source: World, intent: DoomFork, index: number): Promise<World> {
    const action = intent.actions[index];
    if (!action || !(action in actions) || intent.actions.length !== intent.ids.length) throw new Error('Fork has an invalid action catalogue');
    const candidate = intent.candidates?.[index], plan = intent.plans?.[index];
    const world = await this.readWorld(runtime, { role: 'experiment', parentId: intent.parentId, generation: source.view.generation + 1,
      label: candidate?.label ?? plan?.label ?? actions[action].label, probability: candidate?.probability, policyRevision: intent.policyRevision, learning: intent.learning });
    const baseline = intent.baseline ?? this.baseline ?? source.view.state;
    if (!isDeepStrictEqual(world.view.state, baseline)) throw new Error(`Fork child ${runtime.id} does not match the captured game state`);
    world.lastJevDecision = structuredClone(source.lastJevDecision);
    world.view.temporaryGoal = structuredClone(source.view.temporaryGoal);
    return world;
  }
  private stageFork(children: World[], source: World, intent: DoomFork): () => void {
    const old = { baseline: this.baseline, experiments: this.experiments, directorWorldIds: this.view.directorWorldIds,
      commentary: [...this.view.commentary], sequence: this.sequence };
    const undo = () => {
      this.baseline = old.baseline; this.experiments = old.experiments; this.view.directorWorldIds = old.directorWorldIds;
      this.view.commentary = old.commentary; this.sequence = old.sequence;
    };
    try {
      this.baseline = structuredClone(intent.baseline ?? this.baseline ?? source.view.state);
      const horizon = intent.horizon ?? this.options.horizon, actionTicks = intent.actionTicks ?? 35;
      const additions: Experiment[] = [];
      for (const child of children) {
        const index = intent.ids.indexOf(child.view.id), action = intent.actions[index]!;
        child.view.trial = { elapsed: 0, total: horizon, healthChange: 0, kills: 0, distance: 0 };
        child.view.currentAction = actions[action].label;
        if (source.view.decisionOptions) child.view.decisionOptions = { ...structuredClone(source.view.decisionOptions), selected: intent.plans?.[index]?.id ?? action };
        additions.push({ id: child.view.id, action, remaining: horizon,
          nextDecisionTick: this.baseline.tick + ((intent.skillsRevision ?? 0) === (this.view.skillsRevision ?? 0) ? actionTicks : 0) });
        if (intent.plans?.[index]) this.installPlan(child, intent.plans[index]!, this.planDuration(horizon, actionTicks), intent.skillsRevision ?? 0);
        this.say(child.view.id, `Forked at tick ${this.baseline.tick}. Testing ${child.view.label}.`);
      }
      this.experiments = [...this.experiments, ...additions];
      this.view.directorWorldIds = intent.ids.filter(id => this.worlds.has(id));
      const missing = intent.ids.filter(id => !this.worlds.has(id));
      if (missing.length) this.say(source.view.id, `${missing.length} requested fork child(ren) are no longer present. Recovered ${this.view.directorWorldIds.length} existing child(ren); no replacement worlds were created.`);
      return undo;
    } catch (error) { undo(); throw error; }
  }
  private async executeDecision(main: World, judgment: DoomJudgment, limits: DoomLoopLimits, signal: AbortSignal) {
    const { decision } = judgment.data;
    const { horizon, actionTicks } = limits;
    const selectedPlan = decision.plans?.candidates.find(p => p.id === decision.plans!.selected);
    if (selectedPlan) {
      this.installPlan(main, selectedPlan, this.planDuration(horizon, actionTicks));
      await this.advancePlan(main, this.planDuration(horizon, actionTicks), signal);
      main.view.status = main.view.state.alive ? 'paused' : 'ended';
      return;
    }
    main.plan = undefined; main.view.plan = undefined;
    this.say(main.view.id, `Jev chose ${actions[decision.action].label} (${Math.round(decision.confidence * 100)}% confidence).`);
    main.view.status = 'running';
    main.view.currentAction = actions[decision.action].label;
    const actionStart = structuredClone(main.view.state);
    let remaining = actionTicks;
    while (remaining > 0 && !signal.aborted && main.view.state.alive
      && main.view.state.phase === actionStart.phase && main.view.state.map === actionStart.map && main.view.state.episode === actionStart.episode) {
      const started = performance.now();
      const ticks = Math.min(this.control ? 1 : this.options.frameTicks ?? 7, remaining);
      const inputs = this.control ? await this.controlledInputs(main, actions[decision.action].inputs) : actions[decision.action].inputs;
      if (signal.aborted) break;
      await this.refresh(main, await main.runtime!.step({ ticks, inputs }));
      remaining -= ticks;
      await this.pace(signal, started);
    }
    this.memory.remember(main.view.id, actions[decision.action].label, actionStart, main.view.state);
    main.view.status = main.view.state.alive ? 'paused' : 'ended';
  }
  private async explore(signal: AbortSignal) {
    await runTrials(this.experiments.map(e => {
      const w = this.world(e.id);
      return {
        id: e.id,
        baseline: { sequence: this.baseline!.tick, elapsed: this.baseline!.tick / 35, unit: 'seconds' as const },
        duration: { amount: (w.view.trial?.total ?? this.options.horizon) / 35, unit: 'seconds' as const },
        clock: () => ({ sequence: w.view.state.tick, elapsed: w.view.state.tick / 35, unit: 'seconds' as const }),
        terminal: () => !w.view.state.alive || w.view.state.phase !== 'level'
          || w.view.state.map !== this.baseline!.map || w.view.state.episode !== this.baseline!.episode,
        progress: (remaining: { amount: number }) => { e.remaining = Math.round(remaining.amount * 35); },
        advance: async (_remaining: { amount: number }, branchSignal: AbortSignal) => {
          if (w.plan?.status === 'running') {
            await this.advancePlan(w, e.remaining, branchSignal);
            e.nextDecisionTick = w.view.state.tick;
            return;
          }
          if (w.view.state.tick >= (e.nextDecisionTick ?? this.baseline!.tick + 35)) {
            w.view.thinking = true; w.view.status = 'paused'; this.emitView();
            const decisionTicks = Math.min(this.decisionTicks(w.view.trial?.total), e.remaining);
            const { decision: result } = await this.ask(w, branchSignal, decisionTicks, e.remaining);
            if (branchSignal.aborted) return;
            w.view.thinking = false;
            const plan = result.plans?.candidates.find(p => p.id === result.plans!.selected);
            if (plan) { this.installPlan(w, plan, this.planDuration(e.remaining, decisionTicks)); return; }
            w.plan = undefined; w.view.plan = undefined;
            e.action = result.action;
            e.nextDecisionTick = w.view.state.tick + decisionTicks;
            w.view.currentAction = actions[e.action].label;
            this.say(e.id, `Next action: ${actions[e.action].label}.`);
          }
          const started = performance.now();
          w.view.status = 'running';
          e.actionStart ??= structuredClone(w.view.state);
          const ticks = Math.min(this.control ? 1 : this.options.frameTicks ?? 7, e.remaining, (e.nextDecisionTick ?? this.baseline!.tick + 35) - w.view.state.tick);
          const inputs = this.control ? await this.controlledInputs(w, actions[e.action].inputs) : actions[e.action].inputs;
          if (branchSignal.aborted) return;
          await this.refresh(w, await w.runtime!.step({ ticks, inputs }));
          e.remaining -= ticks;
          if (!w.view.state.alive || e.remaining <= 0 || w.view.state.tick >= (e.nextDecisionTick ?? this.baseline!.tick + 35)) {
            this.memory.remember(w.view.id, actions[e.action].label, e.actionStart, w.view.state);
            e.actionStart = undefined;
          }
          await this.pace(branchSignal, started);
        },
        settled: () => {
          w.view.thinking = false;
          w.view.status = w.view.state.alive ? 'paused' : 'ended';
          this.emitView();
        },
      };
    }), signal);
    // Every sibling uses the policy captured for the opening judgment, even if
    // subsequent per-world decisions use updated instructions or controls.
    const scoringReference = this.view.decision?.policyRevision;
    const shaping = scoringReference ? this.policies.get(scoringReference.version)?.policy.values.outcomeWeights : undefined;
    for (const e of this.experiments) {
      const w = this.world(e.id);
      w.view.status = w.view.state.alive ? 'paused' : 'ended';
      const novelCells = Math.max(0, w.stats.visited.length - this.world(this.mainId).stats.visited.length);
      w.view.score = outcomeScore(this.baseline!, w.view.state, this.priority, novelCells, shaping);
    }
    if (!signal.aborted) {
      this.view.stage = 'choosing';
      const best = this.rankExperiments()[0];
      if (best) {
        const trial = best.view.trial;
        const healthChange = best.view.state.health - this.baseline!.health;
        this.view.comparison = { candidateIds: this.experiments.map(e => e.id), bestId: best.view.id, selected: false,
          reason: `Best measured ${this.priority} outcome: ${best.view.state.health} health (${healthChange >= 0 ? '+' : ''}${healthChange}), ${trial?.kills ?? 0} kills, ${trial?.distance ?? 0} units moved.` };
      }
      for (const e of this.experiments) { const w = this.world(e.id); this.say(e.id, `Trial finished: health ${w.view.state.health}, ammo ${w.view.state.ammo[0]}, ${w.view.trial?.kills ?? 0} new map kills during this trial.`); }
      this.say(this.mainId, 'Experiments finished. Outcomes are ready to compare.');
    }
    this.emitView();
  }
  private rankExperiments() {
    return this.experiments.map(e => this.world(e.id)).filter(w => w.view.state.alive).sort((a, b) => {
      if (this.recovery.policy.enabled && this.recovery.points.length && this.baseline) {
        const acceptable = Number(Boolean(this.poorOutcome(a))) - Number(Boolean(this.poorOutcome(b)));
        if (acceptable) return acceptable;
      }
      return (b.view.score ?? -Infinity) - (a.view.score ?? -Infinity);
    });
  }
  private async pace(signal: AbortSignal, started: number) { await this.waitFor(Math.max(0, this.options.paceMs - (performance.now() - started)), signal); }
  private waitFor(milliseconds: number, signal: AbortSignal) { return waitFor(milliseconds, signal); }
  async collectGarbage(destroy: (id: string, identity: string) => Promise<void>) {
    if (this.active || this.lifecycle.busy || this.checkpointRecovery.busy || this.forks.busy) return;
    await this.cleanCheckpoints();
    await this.lifecycle.collect(destroy);
  }
  async close() {
    await this.pause();
    await Promise.all([...this.worlds.values()].flatMap(w => w.runtime ? [w.runtime.destroy()] : []));
    this.recovery.cleanup.push(...this.recovery.points.map(p => p.reference)); this.recovery.points = [];
    await this.cleanCheckpoints();
  }
}
