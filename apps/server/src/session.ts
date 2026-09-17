import { discardForcedKeyStrategy } from './session-policy-upgrade.ts';
import { validateSkills, skillInput } from './ai-skills.ts';
import { activeSkills, type AiSkill } from '../../../packages/contracts/src/skills.ts';
import { observePickups, type PickupMemory } from './doom-pickup-memory.ts';
import { decisionStatistics } from './decision-context.ts';
import { geometryFor } from './doom-geometry.ts';
import { startPlan, stopPlan, planInputs, planView, type PlanExecution, type GamePlan } from './doom-plans.ts';
import type { NavigationMemory } from './doom-navigation.ts';
import { randomUUID } from 'node:crypto';
import { advanceStats, initialStats, type TimelineStats } from './run-stats.ts';
import type { CheckpointAdapter } from './checkpoints.ts';
import { ExperienceMemory, type Experience } from './experience.ts';
import { EventEmitter } from 'node:events';
import type { GameState, Input } from '../../../packages/contracts/src/game.ts';
import type { RecoveryPolicy, SessionView, WorldView } from '../../../packages/contracts/src/session.ts';
import type { WorldRuntime } from './runtime.ts';
import { actions, type ActionId, type DecisionMaker, type Priority } from './jev.ts';

type World = { view: WorldView; runtime?: WorldRuntime; frame: Buffer; history: GameState[]; stats: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution };
type Experiment = { id: string; action: ActionId; remaining: number; nextDecisionTick?: number; actionStart?: GameState };
type RecoveryPoint = { id: string; reference: string; createdAt: number; world: WorldView; history: GameState[]; stats: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution };
type RecoveryState = {
  policy: RecoveryPolicy; points: RecoveryPoint[]; cleanup: string[]; failures: number;
  pendingCapture?: string; pendingRestore?: { id: string; pointId: string }; message?: string;
};
const newRecovery = (): RecoveryState => ({ policy: { enabled: false, maxRetries: 2, healthLoss: 15, stallSeconds: 15 }, points: [], cleanup: [], failures: 0 });
const newAttempts = () => ({ ticks: 0, kills: 0, deaths: 0, rejectedBatches: 0, retries: 0, rollbacks: 0 });
export interface SessionCheckpoint {
  version: 1;
  recovery?: RecoveryState;
  attempts?: ReturnType<typeof newAttempts>;
  view: SessionView;
  worlds: Array<{ view: WorldView; identity?: string; frame: string; history: GameState[]; stats?: TimelineStats; navigation?: NavigationMemory; pickups?: PickupMemory; plan?: PlanExecution }>;
  experiments: Experiment[];
  baseline?: GameState;
  priority: Priority;
  experience?: { enabled: boolean; records: Experience[]; capacity?: number; contextLimit?: number };
  cleanup?: Array<{ id: string; identity: string }>;
  recordingResetTo?: string;
  pendingFork?: { parentId: string; ids: string[]; actions: ActionId[]; horizon?: number; actionTicks?: number; plans?: Array<GamePlan | undefined>; skillsRevision?: number };
}
export function outcomeScore(before: GameState, after: GameState, priority: Priority, novelCells = 0): number {
  if (!after.alive) return -1_000_000;
  const exited = after.map !== before.map || after.episode !== before.episode || after.phase === 'intermission';
  const health = after.health - before.health;
  const sameMap = before.map === after.map && before.episode === after.episode;
  const kills = Math.max(0, after.kills - (sameMap ? before.kills : 0));
  return (exited ? 100_000 : 0) + health * (priority === 'survival' ? 30 : 10)
    + kills * (priority === 'combat' ? 150 : 40) + Math.max(0, novelCells) * (priority === 'exploration' ? 12 : 3)
    + (Math.max(0, after.items - (sameMap ? before.items : 0))) * 10 + (Math.max(0, after.secrets - (sameMap ? before.secrets : 0))) * 100
    + (after.ammo.reduce((a, b) => a + b, 0) - before.ammo.reduce((a, b) => a + b, 0)) * 0.1;
}

export class Session extends EventEmitter {
  private recovery = newRecovery();
  private attempts = newAttempts();
  private checkpointAdapter?: CheckpointAdapter;
  setCheckpointAdapter(adapter: CheckpointAdapter) { this.checkpointAdapter = adapter; }
  private memory = new ExperienceMemory();
  private memoryEnabled = false;
  private memoryPerDecision = 2;
  private memoryUsed = 0;
  private memoryEvidence: NonNullable<SessionView['experience']>['evidence'] = [];
  private worlds = new Map<string, World>();
  private active?: Promise<void>;
  private abort?: AbortController;
  private experiments: Experiment[] = [];
  private baseline?: GameState;
  private priority: Priority = 'exploration';
  private sequence = 0;
  private cleanup: Array<{ id: string; identity: string }> = [];
  private recordingResetTo?: string;
  private pendingFork?: SessionCheckpoint['pendingFork'];
  private control?: (state: GameState, inputs: Input[], navigation: NavigationMemory) => Promise<Input[]>;
  setControls(control: (state: GameState, inputs: Input[], navigation: NavigationMemory) => Promise<Input[]>) { this.control = control; }
  private record?: (world: WorldView, frame: Buffer) => Promise<void>;
  setRecorder(record: (world: WorldView, frame: Buffer) => Promise<void>) { this.record = record; }
  private retainRecording?: (id: string) => Promise<void>;
  setMainRecorder(retain: (id: string) => Promise<void>) { this.retainRecording = retain; }
  private save?: (checkpoint: SessionCheckpoint) => Promise<void>;
  private view: SessionView = { worlds: [], mainId: '', running: false, busy: false, stage: 'ready', planningMode: 'plans', objective: 'survive and reach the exit', commentary: [] };
  constructor(private readonly decisionMaker: DecisionMaker, private readonly options: { threshold: number; horizon: number; branches: number; paceMs: number; frameTicks?: number; reviewMs?: number; continueMs?: number } = { threshold: 0.75, horizon: 210, branches: 4, paceMs: 1000 / 35, frameTicks: 1, reviewMs: 0, continueMs: 0 }) { super(); this.view.forkThreshold = options.threshold; this.view.winnerDelaySeconds = (options.reviewMs ?? 0) / 1000; this.view.decisionIntervalTicks = 35; this.view.trialDurationTicks = options.horizon; }

  async initialize(runtime: WorldRuntime) {
    if (this.worlds.size) throw new Error('Session already initialized');
    await this.add(runtime, { generation: 0, role: 'main', label: 'main session' });
    this.view.mainId = runtime.id;
    await this.retainRecording?.(runtime.id);
    this.say(runtime.id, 'Main session ready. Resume AI play or take control.');
    this.emitView();
  }
  setPersistence(save: (checkpoint: SessionCheckpoint) => Promise<void>) { this.save = save; }
  checkpoint(): SessionCheckpoint {
    return structuredClone({ version: 1, recovery: this.recovery, attempts: this.attempts, experience: { enabled: this.memoryEnabled, records: this.memory.records, capacity: this.memory.capacity, contextLimit: this.memoryPerDecision }, view: this.snapshot(), experiments: this.experiments, baseline: this.baseline, priority: this.priority, cleanup: this.cleanup, recordingResetTo: this.recordingResetTo, pendingFork: this.pendingFork,
      worlds: [...this.worlds.values()].map(w => ({ view: w.view, identity: w.runtime?.identity, frame: w.frame.toString('base64'), history: w.history, stats: w.stats, navigation: w.navigation, pickups: w.pickups, plan: w.plan })) });
  }
  private async persist() { await this.save?.(this.checkpoint()); }
  async restore(saved: SessionCheckpoint, reconnect: (id: string, identity: string) => Promise<WorldRuntime>,
    recoverPending?: (id: string) => Promise<WorldRuntime | undefined>,
    destroyPending?: (id: string, identity: string) => Promise<void>) {
    if (this.worlds.size) throw new Error('Session already initialized');
    saved = discardForcedKeyStrategy(saved);
    const mains = saved.worlds.filter(w => w.view.role === 'main');
    if (mains.length !== 1 || mains[0]!.view.id !== saved.view.mainId) throw new Error('Saved session has an invalid main world');
    this.recovery = structuredClone(saved.recovery ?? newRecovery());
    this.attempts = structuredClone(saved.attempts ?? newAttempts());
    this.memory.setCapacity(saved.experience?.capacity ?? 128);
    this.memoryPerDecision = saved.experience?.contextLimit ?? 2;
    this.memory.records = structuredClone(saved.experience?.records ?? []).slice(-this.memory.capacity);
    this.memoryEnabled = saved.experience?.enabled ?? false;
    this.view = structuredClone(saved.view);
    this.view.skills = validateSkills(saved.view.skills ?? []);
    this.view.forkThreshold ??= this.options.threshold;
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
      this.worlds.set(view.id, { view, runtime, frame: runtime ? await runtime.frame() : Buffer.from(record.frame, 'base64'), history: record.history, stats, navigation: structuredClone(record.navigation), pickups: observePickups(view.state, record.pickups), plan: structuredClone(record.plan) });
    }
    // Do not replay a possibly completed input after a crash. Compare actual engine ticks.
    for (const experiment of this.experiments) {
      const state = this.world(experiment.id).view.state;
      experiment.remaining = Math.max(0, (this.baseline?.tick ?? state.tick) + (this.world(experiment.id).view.trial?.total ?? this.options.horizon) - state.tick);
    }
    if (this.pendingFork && recoverPending) {
      const pending = this.pendingFork;
      const parent = this.world(pending.parentId);
      this.baseline ??= structuredClone(parent.view.state);
      for (const [index, id] of pending.ids.entries()) {
        if (this.worlds.has(id)) continue;
        const child = await recoverPending(id);
        if (!child) continue;
        const state = await child.state();
        if (state.tick !== this.baseline.tick) throw new Error(`Pending child ${id} is not at its captured baseline`);
        const action = pending.actions[index]!;
        await this.add(child, { role: 'experiment', parentId: pending.parentId, generation: parent.view.generation + 1, label: actions[action].label });
        const horizon = pending.horizon ?? this.options.horizon;
        this.world(id).view.trial = { elapsed: 0, total: horizon, healthChange: 0, kills: 0, distance: 0 };
        if (pending.plans?.[index]) this.installPlan(this.world(id), pending.plans[index]!, horizon, pending.skillsRevision ?? 0);
        this.experiments.push({ id, action, remaining: horizon, nextDecisionTick: this.baseline.tick + ((pending.skillsRevision ?? 0) === (this.view.skillsRevision ?? 0) ? (pending.actionTicks ?? 35) : 0) });
      }
      this.pendingFork = undefined;
      this.say(this.view.mainId, 'Recovered the interrupted fork. Existing children are ready to continue.');
    }
    if (this.pendingFork) throw new Error('Interrupted fork requires a runtime reconciliation adapter');
    if (this.experiments.length) this.view.stage = this.experiments.some(e => e.remaining > 0) ? 'exploring' : 'choosing';
    else this.view.stage = 'ready';
    if (this.recovery.pendingCapture) {
      this.recovery.cleanup.push(this.recovery.pendingCapture);
      this.recovery.pendingCapture = undefined;
    }
    if (this.recovery.pendingRestore) {
      if (!recoverPending) throw new Error('Interrupted rollback requires runtime reconciliation');
      const pending = this.recovery.pendingRestore;
      const runtime = await recoverPending(pending.id);
      if (runtime) await this.installRollback(runtime, pending.pointId);
      else this.recovery.pendingRestore = undefined;
    }
    await this.cleanCheckpoints();
    for (const entry of [...this.cleanup]) {
      if (!destroyPending) throw new Error('Pending sandbox cleanup requires a runtime cleanup adapter');
      await destroyPending(entry.id, entry.identity);
      this.cleanup = this.cleanup.filter(c => c.id !== entry.id);
    }
    this.say(this.view.mainId, 'Reconnected to existing sandboxes. Play is paused.');
    await this.persist(); this.emitView();
  }
  snapshot(): SessionView {
    const main = this.worlds.get(this.view.mainId), stats = main?.stats;
    return structuredClone({ ...this.view,
      recovery: { policy: this.recovery.policy, failures: this.recovery.failures, message: this.recovery.message,
        checkpoints: this.recovery.points.map(p => ({ id: p.id, createdAt: p.createdAt, tick: p.world.state.tick, health: p.world.state.health, kills: p.stats.kills, map: `E${p.world.state.episode}M${p.world.state.map}` })) },
      stats: main && stats ? { kills: stats.kills, items: stats.items, secrets: stats.secrets, levels: stats.levels, seconds: stats.ticks / 35,
        health: main.view.state.health, armor: main.view.state.armor, ammo: main.view.state.ammo, damage: stats.damage, healing: stats.healing,
        ammoSpent: stats.ammoSpent, cells: stats.visited.length, partial: stats.partial,
        attempts: { seconds: this.attempts.ticks / 35, kills: this.attempts.kills, deaths: this.attempts.deaths, rejectedBatches: this.attempts.rejectedBatches, retries: this.attempts.retries, rollbacks: this.attempts.rollbacks } } : undefined,
      experience: { enabled: this.memoryEnabled, stored: this.memory.records.length, used: this.memoryUsed, capacity: this.memory.capacity, contextLimit: this.memoryPerDecision, evidence: this.memoryEvidence }, worlds: [...this.worlds.values()].map(w => w.view) }); }
  frame(id: string) { return this.world(id).frame; }
  private world(id: string) { const w = this.worlds.get(id); if (!w) throw new Error('Unknown world'); return w; }
  private emitView() { this.emit('change', this.snapshot()); }
  private say(worldId: string, text: string) {
    this.view.commentary.push({ id: ++this.sequence, worldId, text, at: Date.now() });
    this.view.commentary = this.view.commentary.slice(-100);
  }
  private async add(runtime: WorldRuntime, fields: Pick<WorldView, 'generation' | 'role' | 'label'> & { parentId?: string; probability?: number }) {
    const state = await runtime.state(), frame = await runtime.frame();
    this.worlds.set(runtime.id, { runtime, frame, history: [state], pickups: observePickups(state, fields.parentId ? this.world(fields.parentId).pickups : undefined), navigation: structuredClone(fields.parentId ? this.world(fields.parentId).navigation : undefined), stats: structuredClone(fields.parentId ? this.world(fields.parentId).stats : initialStats(state)), view: { ...fields, currentAction: fields.role === 'experiment' ? fields.label : undefined, id: runtime.id, state, status: 'paused', controller: 'ai', frameVersion: 1 } });
    await this.record?.(this.world(runtime.id).view, frame);
  }
  setPlanningMode(mode: 'plans' | 'actions') { this.view.planningMode = mode; this.emitView(); }
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
    const run = world.plan!;
    let elapsed = 0;
    while (elapsed < remaining && !signal.aborted && run.status === 'running') {
      if ((run.skillsRevision ?? 0) !== (this.view.skillsRevision ?? 0)) { stopPlan(run, 'replan', 'AI skills updated'); break; }
      if (this.view.pendingObjective || run.guide && run.guide !== this.view.objective) { stopPlan(run, 'replan', 'AI guide updated'); break; }
      const started = performance.now(), oldStep = run.step;
      let inputs = planInputs(run, world.view.state, world.history, await geometryFor(world.view.state, true, true));
      world.view.plan = planView(run);
      if (run.status !== 'running') break;
      world.view.currentAction = run.plan.steps[run.step]!.label;
      if (oldStep !== run.step) this.say(world.view.id, `${run.plan.label}: step ${run.step + 1}/${run.plan.steps.length}, ${world.view.currentAction}.`);
      // Let an in-progress collision escape finish before steering toward the
      // waypoint again. Pure plan turns must not lock onto another enemy.
      if (world.navigation?.escape) inputs = ['forward'];
      if (this.control && !inputs.every(i => i === 'left' || i === 'right')) inputs = await this.controlledInputs(world, inputs);
      if (signal.aborted) break;
      world.view.status = 'running';
      await this.refresh(world, await world.runtime!.step({ ticks: 1, inputs }));
      elapsed++;
      await this.pace(signal, started);
    }
    // Record condition/limit transitions at the final frame as well as before
    // the next input. This prevents a completed trial showing an active plan.
    if (!signal.aborted && run.status === 'running') planInputs(run, world.view.state, world.history, await geometryFor(world.view.state, true, true));
    world.view.plan = planView(run);
    if (run.status !== 'running') {
      this.memory.remember(world.view.id, run.plan.label, run.started, world.view.state);
      this.say(world.view.id, `${run.plan.label}: ${run.reason}.`);
    }
    return elapsed;
  }
  private async controlledInputs(world: World, inputs: Input[]) {
    const previousEscape = world.navigation?.escape;
    const result = await this.control!(world.view.state, inputs, world.navigation ??= {});
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
    if (world.view.role === 'experiment' && this.baseline) world.view.trial = {
      elapsed: state.tick - this.baseline.tick, total: world.view.trial?.total ?? this.options.horizon,
      healthChange: state.health - this.baseline.health, kills: (world.view.trial?.kills ?? 0) + world.stats.kills - killsBefore,
      distance: Math.round(Math.hypot(state.x - this.baseline.x, state.y - this.baseline.y)),
    };
    world.history.push(state);
    world.history = world.history.slice(-10);
    if (world.plan) {
      const previousStep = world.plan.step;
      planInputs(world.plan, state, world.history, await geometryFor(state, true, true));
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
    await this.pausedOperation(async () => {
      const point = this.recovery.points.find(p => p.id === id);
      if (!point) throw new Error('Unknown checkpoint');
      this.recovery.points = this.recovery.points.filter(p => p.id !== id);
      this.recovery.cleanup.push(point.reference);
      await this.persist(); await this.cleanCheckpoints();
    });
  }
  private shouldCheckpoint(main: World) {
    const last = this.recovery.points.at(-1)!;
    return main.stats.ticks - last.stats.ticks >= 30 * 35 && main.view.state.health >= Math.max(40, last.world.state.health)
      && (main.stats.levels > last.stats.levels || main.stats.kills > last.stats.kills
        || main.stats.visited.length >= last.stats.visited.length + 4);
  }
  private async capturePoint() {
    if (!this.checkpointAdapter) throw new Error('Execution checkpoints are unavailable');
    const main = this.world(this.view.mainId);
    if (!main.view.state.alive || main.view.state.phase !== 'level') throw new Error('Checkpoint a living player inside a level');
    const id = randomUUID();
    // Unique names avoid group-head conflicts; lineage can still cross groups.
    const reference = `mom-checkpoint-${id}:recovery`;
    this.recovery.pendingCapture = reference;
    await this.persist();
    await this.checkpointAdapter.capture(main.runtime!, reference);
    this.recovery.points.push({ id, reference, createdAt: Date.now(), world: structuredClone(main.view), history: structuredClone(main.history), stats: structuredClone(main.stats), navigation: structuredClone(main.navigation), pickups: structuredClone(main.pickups), plan: structuredClone(main.plan) });
    this.recovery.pendingCapture = undefined;
    while (this.recovery.points.length > 3) this.recovery.cleanup.push(this.recovery.points.shift()!.reference);
    await this.retainRecording?.(main.view.id);
    await this.persist(); await this.cleanCheckpoints();
    this.recovery.message = `Checkpoint saved at ${(main.view.state.tick / 35).toFixed(1)}s with ${main.view.state.health} health.`;
    this.say(main.view.id, this.recovery.message); this.emitView();
  }
  private checkpointCleanup: Promise<void> = Promise.resolve();
  private async cleanCheckpoints() {
    const work = async () => {
      if (!this.recovery.cleanup.length) return;
      if (!this.checkpointAdapter) throw new Error('Checkpoint cleanup requires its runtime adapter');
      const adapter = this.checkpointAdapter;
      const references = [...this.recovery.cleanup];
      if (adapter.collect) {
        const removed = new Set(await adapter.collect(references));
        this.recovery.cleanup = this.recovery.cleanup.filter(reference => !removed.has(reference));
        await this.persist();
      } else {
        for (const reference of references) {
          await adapter.remove(reference);
          this.recovery.cleanup = this.recovery.cleanup.filter(r => r !== reference);
          await this.persist();
        }
      }
    };
    const task = this.checkpointCleanup.then(work);
    this.checkpointCleanup = task.catch(() => {});
    await task;
  }
  private async restorePoint(pointId: string) {
    const point = this.recovery.points.find(p => p.id === pointId);
    if (!point || !this.checkpointAdapter) throw new Error('Checkpoint is unavailable');
    const id = `mom-rollback-${randomUUID().slice(0, 12)}`;
    this.recovery.pendingRestore = { id, pointId };
    await this.persist();
    // Keep the old run intact until the restored VM has been read and validated.
    const runtime = await this.checkpointAdapter.restore(point.reference, id);
    await this.installRollback(runtime, pointId);
  }
  private async installRollback(runtime: WorldRuntime, pointId: string) {
    const point = this.recovery.points.find(p => p.id === pointId);
    if (!point) throw new Error('Rollback checkpoint metadata is missing');
    const state = await runtime.state();
    const { isDeepStrictEqual } = await import('node:util');
    if (!isDeepStrictEqual(state, point.world.state)) throw new Error('Restored execution differs from the saved checkpoint; old run retained');
    const frame = await runtime.frame();
    this.worlds.set(runtime.id, { runtime, frame, history: structuredClone(point.history), stats: structuredClone(point.stats), navigation: structuredClone(point.navigation), pickups: structuredClone(point.pickups), plan: structuredClone(point.plan), view: {
      ...structuredClone(point.world), id: runtime.id, parentId: point.world.id, state,
      generation: point.world.generation + 1, role: 'experiment', status: 'paused', controller: 'ai',
      label: 'restored checkpoint', currentAction: undefined, thinking: false, trial: undefined, score: undefined, probability: undefined,
    } });
    await this.record?.(this.world(runtime.id).view, frame);
    this.recovery.pendingRestore = undefined;
    this.recovery.failures = 0;
    this.attempts.rollbacks++;
    this.view.directorWorldIds = undefined; this.view.comparison = undefined; this.view.decision = undefined;
    this.view.confidence = undefined; this.view.running = false; this.view.error = undefined;
    // Do not leave newer checkpoints from the abandoned route as automatic targets.
    const index = this.recovery.points.findIndex(p => p.id === pointId);
    this.recovery.cleanup.push(...this.recovery.points.splice(index + 1).map(p => p.reference));
    await this.select(runtime.id);
    await this.cleanCheckpoints();
    this.recovery.message = 'Rolled back to the checkpoint. Experience and previous recordings are kept. Paused for review.';
    this.say(runtime.id, this.recovery.message); this.emitView();
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
    if (this.recovery.failures <= this.recovery.policy.maxRetries) {
      this.attempts.retries++;
      // The unchanged source is the exact retry point. Rotate opening candidates
      // on the next attempt; remembered outcomes can also inform Jev when enabled.
      await this.select(this.view.mainId);
      this.view.comparison = undefined;
      this.recovery.message = `Rejected batch: ${reason}. Retry ${this.recovery.failures}/${this.recovery.policy.maxRetries} from the same state; opening candidates rotate where alternatives remain.`;
      this.say(this.view.mainId, this.recovery.message);
      await this.persist(); this.emitView();
    } else if (!signal.aborted) {
      await this.restorePoint(this.recovery.points.at(-1)!.id);
    }
  }

  setTrialDuration(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 35 || ticks > 2100) throw new Error('Trial duration must be 35–2100 game ticks (1–60 seconds)');
    this.view.trialDurationTicks = ticks;
    this.emitView(); // Each batch captures its own horizon before its first judgment.
  }
  setDecisionInterval(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 7 || ticks > 210) throw new Error('Decision interval must be 7–210 game ticks (0.2–6 seconds)');
    this.view.decisionIntervalTicks = ticks;
    this.emitView(); // In-flight actions retain their boundary; subsequent judgments use this value.
  }
  setWinnerDelay(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Winner delay must be between 0 and 60 seconds');
    this.view.winnerDelaySeconds = seconds;
    if (this.view.reviewEndsAt !== undefined) this.view.reviewEndsAt = Date.now() + seconds * 1000;
    this.emitView();
  }
  useExperience(enabled: boolean) {
    this.memoryEnabled = enabled; this.memoryUsed = 0; this.memoryEvidence = [];
    this.say(this.view.mainId, enabled ? 'Experience enabled. Relevant observed attempts will inform the next decision.' : 'Experience disabled for future decisions. Recorded attempts remain available.');
    this.emitView();
  }
  clearExperience() { this.memory.records = []; this.memoryUsed = 0; this.memoryEvidence = []; this.emitView(); }
  setForkThreshold(threshold: number) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Fork confidence must be between 0 and 1');
    this.view.forkThreshold = threshold; this.emitView();
  }
  configureMemory(capacity: number, perDecision: number) {
    if (!Number.isInteger(perDecision) || perDecision < 1 || perDecision > 8) throw new Error('Decision memory limit must be 1–8 attempts');
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
    const next = validateSkills(skills);
    const changed = JSON.stringify(activeSkills(this.view.skills ?? [])) !== JSON.stringify(activeSkills(next));
    this.view.skills = next;
    if (!changed) { this.emitView(); return; }
    this.view.skillsRevision = (this.view.skillsRevision ?? 0) + 1;
    for (const world of this.worlds.values()) if (world.plan?.status === 'running') {
      stopPlan(world.plan, 'replan', 'AI skills updated'); world.view.plan = planView(world.plan);
    }
    for (const experiment of this.experiments) experiment.nextDecisionTick = this.world(experiment.id).view.state.tick;
    this.say(this.view.mainId, 'AI skills updated. New decisions will use the enabled skills.');
    this.emitView();
  }
  private experiences(state: GameState) { return this.memoryEnabled ? this.memory.relevant(state, this.memoryPerDecision) : []; }
  private applyGuide() {
    if (!this.view.pendingObjective) return;
    this.view.objective = this.view.pendingObjective; this.view.pendingObjective = undefined;
    for (const world of this.worlds.values()) if (world.plan?.status === 'running') {
      stopPlan(world.plan, 'replan', 'AI guide updated'); world.view.plan = planView(world.plan);
    }
    this.say(this.view.mainId, `New objective: ${this.view.objective}`);
  }
  private async ask(world: World, signal: AbortSignal, actionTicks: number, planTicks: number) {
    for (;;) {
      this.applyGuide();
      signal.throwIfAborted();
      const skillsRevision = this.view.skillsRevision ?? 0;
      const objective = this.view.objective, experience = this.experiences(world.view.state);
      const decision = await this.decisionMaker.decide(world.view.state, objective, world.history, signal, experience, actionTicks, {
        skills: structuredClone(this.view.skills ?? []), previousAction: world.view.currentAction, planTicks: this.view.planningMode === 'plans' ? planTicks : undefined,
        stats: decisionStatistics(world.view.state, world.stats), visited: world.stats.visited, pickups: world.pickups,
      });
      // A guide can change while a model call is in flight. Discard its stale
      // judgment, including priority, before applying any resulting input.
      if (signal.aborted || (!this.view.pendingObjective && objective === this.view.objective && skillsRevision === (this.view.skillsRevision ?? 0))) return { decision, experience };
    }
  }
  queueObjective(text: string) {
    if (!text.trim() || text.length > 1000) throw new Error('Direction must contain 1–1000 characters');
    this.view.pendingObjective = text.trim();
    this.say(this.view.mainId, 'Direction queued for the next decision.');
    this.emitView();
  }
  resume() {
    this.requireIdle();
    const human = [...this.worlds.values()].find(w => w.view.controller === 'human');
    if (human) { if (!human.view.state.alive) throw new Error('This world has ended'); human.view.status = 'running'; this.emitView(); return; }
    if (!this.world(this.view.mainId).view.state.alive) throw new Error('Main session has ended');
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
    const main = this.world(this.view.mainId);
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
      const old = { worlds: this.worlds, view: this.view, memory: this.memory, memoryUsed: this.memoryUsed,
        memoryEvidence: this.memoryEvidence, experiments: this.experiments, baseline: this.baseline,
        priority: this.priority, sequence: this.sequence, cleanup: this.cleanup, recovery: this.recovery, attempts: this.attempts };
      this.worlds = new Map([[runtime.id, { runtime, frame, history: [state], stats: initialStats(state), view: {
        id: runtime.id, generation: 0, role: 'main', label: 'main session', status: 'paused',
        controller: 'ai', frameVersion: 1, state,
      } }]]);
      this.view = { worlds: [], mainId: runtime.id, running: false, busy: true, stage: 'ready',
        skills: old.view.skills, skillsRevision: old.view.skillsRevision, forkThreshold: old.view.forkThreshold, planningMode: old.view.planningMode, winnerDelaySeconds: old.view.winnerDelaySeconds, decisionIntervalTicks: old.view.decisionIntervalTicks, trialDurationTicks: old.view.trialDurationTicks, objective: old.view.pendingObjective ?? old.view.objective, commentary: [] };
      this.recovery = { ...newRecovery(), policy: old.recovery.policy, cleanup: [...old.recovery.cleanup, ...old.recovery.points.map(p => p.reference)] };
      this.attempts = newAttempts();
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
  private requireIdle() { if (this.recovery.pendingRestore || this.recovery.pendingCapture) throw new Error('Reconcile the interrupted checkpoint operation by restarting the backend'); if (this.recordingResetTo) throw new Error('Restart cleanup is incomplete; restart the backend to finish it'); if (this.pendingFork) throw new Error('Reconcile the interrupted fork first'); if (this.active || this.view.running) throw new Error('Pause before this operation'); }
  private launch(work: (signal: AbortSignal) => Promise<void>) {
    this.abort = new AbortController();
    this.view.busy = true;
    this.view.error = undefined;
    this.active = work(this.abort.signal).catch(error => {
      if (!this.abort?.signal.aborted) {
        this.view.error = error instanceof Error ? error.message : 'Session error';
        this.view.stage = 'error';
        this.say(this.view.mainId, this.view.error);
      }
    }).finally(() => {
      this.view.running = false;
      this.view.busy = false;
      this.active = undefined;
      for (const w of this.worlds.values()) if (w.view.status === 'running' && w.view.controller === 'ai') w.view.status = 'paused';
      this.emitView();
    });
    this.emitView();
  }
  async idle() { await this.active; }
  async pause() {
    this.view.running = false;
    this.view.reviewEndsAt = undefined;
    this.abort?.abort();
    for (const world of this.worlds.values()) if (world.view.status === 'running') world.view.status = 'paused';
    await this.active; // Fence already-dispatched engine ticks before acknowledging pause.
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
  private async select(id: string) {
    const winner = this.world(id);
    const cleanup: WorldRuntime[] = [];
    for (const world of this.worlds.values()) {
      if (world === winner || world.view.role === 'archived') continue;
      if (world.runtime) { cleanup.push(world.runtime); this.cleanup.push({ id: world.runtime.id, identity: world.runtime.identity }); }
      world.runtime = undefined;
      world.view.role = 'archived';
      world.view.status = 'ended';
      world.view.controller = 'ai';
    }
    if (this.view.comparison) this.view.comparison = { ...this.view.comparison, bestId: id, selected: true };
    winner.view.role = 'main';
    winner.view.status = 'paused';
    this.view.mainId = id;
    await this.retainRecording?.(id);
    this.experiments = [];
    this.view.manualChoiceRequired = false;
    this.baseline = undefined;
    this.view.stage = 'ready';
    await this.persist(); // Publish the surviving main before releasing any old VM.
    const released = await Promise.allSettled(cleanup.map(async runtime => {
      await runtime.destroy();
      this.cleanup = this.cleanup.filter(c => c.id !== runtime.id);
    }));
    await this.persist();
    const failed = released.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    this.say(id, 'This world is now the main session. Other worlds are archived.');
    // Retain bounded history and final frames, not live VMs.
    const archived = [...this.worlds.values()].filter(w => w.view.role === 'archived');
    for (const w of archived.slice(0, Math.max(0, archived.length - 20))) this.worlds.delete(w.view.id);
    await this.persist();
    this.emitView();
  }
  private async cycle(signal: AbortSignal, manual: boolean) {
    if (this.experiments.length) {
      if (this.view.stage === 'choosing') {
        const ranked = this.rankExperiments();
        if (this.recovery.policy.enabled && this.recovery.points.length && this.poorOutcome(ranked[0])) {
          await this.rejectBatch(signal); return;
        }
        if (!ranked.length) throw new Error('All experiments ended. Take over the paused main session.');
        const best = ranked[0]!;
        const reviewMs = (this.view.winnerDelaySeconds ?? 0) * 1000;
        if (!manual && reviewMs > 0) {
          this.view.reviewEndsAt = Date.now() + reviewMs;
          this.emitView();
          while (!signal.aborted && this.view.reviewEndsAt && this.view.reviewEndsAt > Date.now()) {
            await this.waitFor(Math.min(100, this.view.reviewEndsAt - Date.now()), signal);
          }
          this.view.reviewEndsAt = undefined;
          if (signal.aborted) return;
        }
        this.recovery.failures = 0;
        await this.select(best.view.id);
        if (!manual && !signal.aborted) {
          this.view.stage = 'continuing'; this.emitView();
          await this.waitFor(this.options.continueMs ?? 0, signal);
          this.view.stage = 'ready'; this.emitView();
        }
      } else await this.explore(signal);
      return;
    }
    const main = this.world(this.view.mainId);
    if (!main.view.state.alive) {
      if (this.recovery.policy.enabled && this.recovery.points.length) await this.restorePoint(this.recovery.points.at(-1)!.id);
      this.view.running = false; return;
    }
    if (this.recovery.policy.enabled && this.checkpointAdapter && (!this.recovery.points.length || this.shouldCheckpoint(main))) {
      await this.capturePoint(); if (signal.aborted) return;
    }
    this.applyGuide();
    if (manual && main.plan) { main.plan = undefined; main.view.plan = undefined; }
    if (main.plan?.status === 'running') {
      this.view.stage = 'acting'; this.emitView();
      await this.advancePlan(main, Math.max(0, main.plan.untilTick - main.view.state.tick), signal);
      this.view.stage = 'ready'; return;
    }
    this.view.stage = 'deciding'; this.emitView();
    const horizon = this.view.trialDurationTicks ?? this.options.horizon;
    const actionTicks = this.view.decisionIntervalTicks ?? 35;
    const { decision, experience: experiences } = await this.ask(main, signal, actionTicks, horizon);
    if (signal.aborted) return;
    this.memoryUsed = decision.experienceUsed ?? 0;
    this.memoryEvidence = experiences.slice(0, this.memoryUsed).map(e => ({ action: e.action, ...e.result }));
    this.view.confidence = decision.confidence; this.view.model = decision.model; this.priority = decision.priority;
    const threshold = this.view.forkThreshold ?? this.options.threshold;
    const stalled = main.view.state.tick - main.stats.lastProgressTick >= 350;
    const mode = manual ? 'manual' : stalled ? 'stalled' : decision.confidence < threshold ? 'uncertain' : 'direct';
    const candidates: Array<{ action: ActionId; label: string; probability: number; plan?: GamePlan }> = decision.plans
      ? decision.plans.candidates.map(plan => ({ action: 'advance', label: plan.label, probability: plan.probability, plan }))
      : (Object.keys(actions) as ActionId[]).filter(id => !decision.perception?.excludedActions.includes(id)).map(action => ({ action, label: actions[action].label, probability: decision.probabilities[action] }));
    candidates.sort((a, b) => b.probability - a.probability);
    const allCandidates = [...candidates];
    const selectedPlan = decision.plans?.candidates.find(p => p.id === decision.plans!.selected);
    const offset = this.recovery.failures * this.options.branches % candidates.length;
    candidates.push(...candidates.splice(0, offset));
    candidates.splice(this.options.branches);
    this.view.routing ??= { direct: 0, uncertain: 0, manual: 0 };
    this.view.routing[mode] = (this.view.routing[mode] ?? 0) + 1;
    this.view.comparison = undefined;
    this.view.decision = { kind: decision.plans ? 'plan' : 'action', action: selectedPlan?.label ?? actions[decision.action].label, mode, threshold, evidence: decision.evidence,
      perception: decision.perception, sourceId: main.view.id, tick: main.view.state.tick, latencyMs: decision.latencyMs,
      preferences: allCandidates.map(candidate => ({ action: candidate.label, probability: candidate.probability, tested: mode !== 'direct' && candidates.includes(candidate) })),
    };
    if (mode !== 'direct') {
      this.view.stage = 'forking';
      this.say(main.view.id, manual ? 'You requested a comparison. Testing alternate approaches from this moment.' : stalled ? 'No useful progress for 10 game seconds. Testing alternatives despite model confidence.' : `Jev confidence ${Math.round(decision.confidence * 100)}%, below the ${Math.round(threshold * 100)}% threshold. Testing alternate actions.`);
      this.emitView();
      const generation = main.view.generation + 1;
      const ids = candidates.map((_, i) => `${main.view.id.split('-g')[0]}-g${generation}-${Date.now().toString(36)}-${i}`);
      this.pendingFork = { parentId: main.view.id, ids, actions: candidates.map(c => c.action), plans: decision.plans ? candidates.map(c => c.plan!) : undefined, skillsRevision: this.view.skillsRevision ?? 0, horizon, actionTicks };
      await this.persist();
      let children: WorldRuntime[];
      try { children = await main.runtime!.branch(ids); }
      catch (error) { this.pendingFork = undefined; await this.persist(); throw error; }
      this.baseline = structuredClone(main.view.state);
      for (const [i, child] of children.entries()) {
        const candidate = candidates[i]!, action = candidate.action;
        await this.add(child, { role: 'experiment', parentId: main.view.id, generation, label: candidate.label, probability: candidate.probability });
        this.world(child.id).view.trial = { elapsed: 0, total: horizon, healthChange: 0, kills: 0, distance: 0 };
        this.experiments.push({ id: child.id, action, remaining: horizon, nextDecisionTick: this.baseline.tick + ((this.pendingFork!.skillsRevision ?? 0) === (this.view.skillsRevision ?? 0) ? actionTicks : 0) });
        this.world(child.id).view.currentAction = actions[action].label;
        if (candidate.plan) this.installPlan(this.world(child.id), candidate.plan, horizon, this.pendingFork!.skillsRevision ?? 0);
        this.say(child.id, `Forked at tick ${this.baseline.tick}. Testing ${candidate.label}.`);
      }
      this.pendingFork = undefined;
      this.view.directorWorldIds = children.map(child => child.id);
      await this.persist();
      this.view.stage = 'exploring'; this.emitView();
      if (!signal.aborted) await this.explore(signal);
    } else {
      this.view.stage = 'acting';
      if (selectedPlan) {
        this.installPlan(main, selectedPlan, horizon);
        await this.advancePlan(main, horizon, signal);
        main.view.status = main.view.state.alive ? 'paused' : 'ended';
        this.view.stage = 'ready'; return;
      }
      main.plan = undefined; main.view.plan = undefined;
      this.say(main.view.id, `Jev chose ${actions[decision.action].label} (${Math.round(decision.confidence * 100)}% confidence).`);
      main.view.status = 'running';
      main.view.currentAction = actions[decision.action].label;
      const actionStart = structuredClone(main.view.state);
      let remaining = actionTicks;
      while (remaining > 0 && !signal.aborted && main.view.state.alive) {
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
      this.view.stage = 'ready';
    }
  }
  private async explore(signal: AbortSignal) {
    // Futures share a game-time horizon, not a wall-clock barrier. A slow
    // judgment in one sandbox must not freeze already-decided siblings.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const branchSignal = controller.signal;
    try {
      const outcomes = await Promise.allSettled(this.experiments.map(async e => {
        const w = this.world(e.id);
        try {
          while (!branchSignal.aborted) {
            e.remaining = Math.max(0, this.baseline!.tick + (w.view.trial?.total ?? this.options.horizon) - w.view.state.tick);
            if (e.remaining <= 0 || !w.view.state.alive) break;
            if (w.plan?.status === 'running') {
              await this.advancePlan(w, e.remaining, branchSignal);
              e.nextDecisionTick = w.view.state.tick;
              continue;
            }
            if (w.view.state.tick >= (e.nextDecisionTick ?? this.baseline!.tick + 35)) {
              w.view.thinking = true; w.view.status = 'paused'; this.emitView();
              const decisionTicks = Math.min(this.view.decisionIntervalTicks ?? 35, e.remaining);
              const { decision: result } = await this.ask(w, branchSignal, decisionTicks, e.remaining);
              if (branchSignal.aborted) return;
              w.view.thinking = false;
              const plan = result.plans?.candidates.find(p => p.id === result.plans!.selected);
              if (plan) { this.installPlan(w, plan, e.remaining); continue; }
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
            if (branchSignal.aborted) break;
            await this.refresh(w, await w.runtime!.step({ ticks, inputs }));
            e.remaining -= ticks;
            if (!w.view.state.alive || e.remaining <= 0 || w.view.state.tick >= (e.nextDecisionTick ?? this.baseline!.tick + 35)) {
              this.memory.remember(w.view.id, actions[e.action].label, e.actionStart, w.view.state);
              e.actionStart = undefined;
            }
            await this.pace(branchSignal, started);
          }
        } catch (error) {
          // Stop siblings on failure, but join every dispatched operation before
          // returning control to pause/takeover or recording a checkpoint.
          controller.abort(); throw error;
        } finally {
          w.view.thinking = false;
          w.view.status = w.view.state.alive ? 'paused' : 'ended';
          this.emitView();
        }
      }));
      const failed = outcomes.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally { signal.removeEventListener('abort', abort); }
    for (const e of this.experiments) {
      const w = this.world(e.id);
      w.view.status = w.view.state.alive ? 'paused' : 'ended';
      const novelCells = Math.max(0, w.stats.visited.length - this.world(this.view.mainId).stats.visited.length);
      w.view.score = outcomeScore(this.baseline!, w.view.state, this.priority, novelCells);
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
      this.say(this.view.mainId, 'Experiments finished. Outcomes are ready to compare.');
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
  private async waitFor(milliseconds: number, signal: AbortSignal) {
    if (signal.aborted || !milliseconds) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  async collectGarbage(destroy: (id: string, identity: string) => Promise<void>) {
    // Only retry identities already journaled for destruction by selection.
    // Never discover/delete arbitrary VMs or race an in-progress lifecycle action.
    if (this.active) return;
    await this.cleanCheckpoints();
    for (const entry of [...this.cleanup]) {
      await destroy(entry.id, entry.identity);
      this.cleanup = this.cleanup.filter(item => item.id !== entry.id);
      await this.persist();
    }
  }
  async close() {
    await this.pause();
    await Promise.all([...this.worlds.values()].flatMap(w => w.runtime ? [w.runtime.destroy()] : []));
    this.recovery.cleanup.push(...this.recovery.points.map(p => p.reference)); this.recovery.points = [];
    await this.cleanCheckpoints();
  }
}
