import { chessGoalFrame, advanceChessTemporaryGoal, decodeChessTemporaryGoal } from './temporary-goal.ts';
import { decideChess } from './decision.ts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_POSITION } from 'chess.js';
import { join } from 'node:path';
import { CheckpointRecovery, EvidenceMemory, ExecutionGate, LearningLoop, WorldForks, WorldLifecycle, canonicalJson, decideCurrent, runTrials,
  type DecisionModel, type LoopJudgment, type PlanDefinition } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore, ReplayStore } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, type ChessExperience, type ChessPlan } from './adapter.ts';
import { ChessRuntimeStore, type StoredChessWorld } from './runtime-store.ts';
import { ChessWorld, type ChessState } from './runtime.ts';
import { defaultChessPolicy, parseChessPolicy, resolveChessPolicy } from './policy.ts';
import { chessLearningProvenance, type ChessLearningBinding, type ChessDecisionModel } from './revisions.ts';
import type { ChessDecisionRequest } from './preparation.ts';
import type { ChessPolicy, ChessProvenance, ChessWorldData, SessionChessWorld, ChessPoint, ChessFork, ChessBatch, ChessSessionCheckpoint } from './session-types.ts';

type Candidate = { probability: number; plan: PlanDefinition<ChessPlan> };
type Judgment = LoopJudgment<Candidate, { selected: PlanDefinition<ChessPlan>; objective: string }>;
type Limits = { breadth: number; plies: number };
type Recording = ChessWorldData & { id: string };
type Model = ChessDecisionModel;
type PinnedLearning = { policy: ChessPolicy; provenance: ChessProvenance; model: Model };

/** Adapter composition example: workflow ordering and durable lifecycle come from the public harness. */
export class ChessSession {
  private goalScopeId: string = randomUUID();
  private readonly gate = new ExecutionGate();
  private readonly worlds: WorldLifecycle<SessionChessWorld, StoredChessWorld>;
  private readonly forks: WorldForks<ChessFork, SessionChessWorld, StoredChessWorld>;
  private readonly checkpoints: CheckpointRecovery<ChessPoint, SessionChessWorld, StoredChessWorld>;
  private readonly memory: EvidenceMemory<ChessState, ChessExperience>;
  private readonly loop: LearningLoop<SessionChessWorld, Candidate, Judgment['data'], Limits>;
  private readonly store: JsonFileStore<ChessSessionCheckpoint>;
  private readonly recordings: ReplayStore<Recording>;
  private readonly provenance: ChessProvenance;
  private points: ChessSessionCheckpoint['points'] = { points: [], cleanup: [] };
  private pendingFork?: ChessFork;
  private batch?: ChessBatch;
  private pendingInputs: ChessSessionCheckpoint['pendingInputs'] = {};
  private attempts = { plies: 0, decisions: 0, forks: 0, rollbacks: 0 };
  private objective = 'win by checkmate';
  private failed = false;
  private pinned?: PinnedLearning;
  private revisionFence = false;
  private games?: ChessSessionCheckpoint['games'];
  private pendingNewGame?: ChessSessionCheckpoint['pendingNewGame'];

  private constructor(readonly directory: string, readonly provider: ChessRuntimeStore, readonly adapter: ChessAdapter, private readonly model: Model, readonly policy: ChessPolicy, private readonly learning?: ChessLearningBinding) {
    const resolved = resolveChessPolicy(policy);
    this.policy = resolved.policy;
    this.provenance = { adapter: adapter.version, model: model.version, policy: resolved.revision };
    this.store = new JsonFileStore(join(directory, 'session.json'), value => value as ChessSessionCheckpoint);
    this.recordings = new ReplayStore(join(directory, 'recordings'), { position: world => world.state.ply, framesPerSegment: 1 }, 16 * 1024 * 1024, { maxAgeMs: 86400000, maxWorlds: 20 });
    this.memory = new EvidenceMemory(adapter.evidence(), policy.memoryCapacity);
    this.worlds = new WorldLifecycle({ metadata: world => world.meta, persist: () => this.persist(), retainReplay: id => this.recordings.retainPath(id),
      stageSelection: () => { const previous = this.batch; this.batch = undefined; return () => { this.batch = previous; }; } });
    this.forks = new WorldForks(this.worlds, {
      pending: () => this.pendingFork, setPending: intent => { this.pendingFork = intent; }, persist: () => this.persist(), fork: (runtime, ids) => runtime.branch(ids),
      attach: async (runtime, _source, intent, index) => {
        const state = await runtime.state();
        if (!same(state, intent.baseline.state)) throw new Error('Forked chess state differs from its source');
        return { ...structuredClone(intent.baseline), state, runtime, parentId: intent.parentId, guidance: intent.objective, label: intent.plans[index]!.label, opening: intent.plans[index],
          meta: { id: runtime.id, role: 'experiment', status: 'paused', controller: 'ai' } };
      },
      stage: (_children, _source, intent) => {
        const previous = this.batch, ids = intent.ids.filter(id => this.worlds.worlds.has(id));
        this.batch = ids.length && previous ? { ...previous, ids } : undefined;
        return () => { this.batch = previous; };
      },
      retain: world => this.record(world),
    });
    this.checkpoints = new CheckpointRecovery(this.worlds, {
      journal: () => this.points, adapter: () => provider.checkpoints(), persist: () => this.persist(), limit: () => this.effectivePolicy().checkpointLimit,
      point: world => { const id = `point-${randomUUID()}`; return { id, reference: id, createdAt: Date.now(), worldId: world.meta.id, data: data(world) }; },
      attach: async (runtime, point) => {
        const state = await runtime.state();
        if (!same(state, point.data.state)) throw new Error('Restored chess state differs from checkpoint');
        const world: SessionChessWorld = { ...structuredClone(point.data), state, runtime, parentId: point.worldId,
          meta: { id: runtime.id, role: 'experiment', status: 'paused', controller: 'ai' } };
        delete world.opening; await this.record(world); return world;
      },
      restoreId: () => `rollback-${randomUUID()}`, retainReplay: point => this.recordings.retainPath(point.worldId),
      stageRestore: () => { const old = this.attempts.rollbacks; this.attempts.rollbacks++; return () => { this.attempts.rollbacks = old; }; },
    });
    this.loop = new LearningLoop({
      state: { main: () => this.main(), terminal: world => adapter.terminal(world.state) !== 'ongoing', batch: () => this.batch ? this.batch.complete ? 'complete' : 'exploring' : 'none' },
      planning: {
        prepare: () => {}, continuing: () => false, continue: async () => {}, limits: () => ({ breadth: this.effectivePolicy().breadth, plies: this.effectivePolicy().trialPlies }),
        decide: (world, _limits, signal) => this.judge(world, signal), routing: world => ({ threshold: world.state.turn === adapter.player ? this.effectivePolicy().threshold : 0, stalled: false, retries: 0 }),
        execute: (world, judgment, _limits, signal) => this.advance(world, judgment.data.selected, signal, judgment.data.objective),
      },
      comparison: {
        create: async (source, candidates, judgment, limits, signal) => {
          const ids = candidates.map(() => `future-${randomUUID()}`);
          this.batch = { ids, baseline: structuredClone(source.state), plies: limits.plies, complete: false, provenance: structuredClone(this.pinned!.provenance) }; this.attempts.forks++;
          await this.forks.create({ parentId: source.meta.id, ids, baseline: { ...data(source), provenance: structuredClone(this.pinned!.provenance) }, objective: judgment.data.objective, plans: candidates.map(c => c.plan), plies: limits.plies }, signal);
        },
        explore: signal => this.explore(signal),
        evaluate: () => ({ winner: this.batch!.ids.map(id => this.worlds.world(id)).sort((a, b) => adapter.value(b.state) - adapter.value(a.state))[0], rejected: false }),
        promote: world => this.worlds.promote(world.meta.id),
      },
      recovery: {
        checkpointNeeded: world => {
          const latest = this.points.points.filter(point => point.data.state.initialFen === world.state.initialFen && point.data.state.moves.every((move, index) => world.state.moves[index] === move))
            .sort((a, b) => b.data.state.ply - a.data.state.ply)[0];
          return !latest || world.state.ply - latest.data.state.ply >= this.effectivePolicy().checkpointEvery;
        },
        checkpoint: async () => { await this.checkpoints.capture(); }, terminal: async () => {}, reject: async () => { throw new Error('Chess outcome adapter did not supply an eligible future'); },
      },
    });
  }

  static async create(directory: string, provider: ChessRuntimeStore, adapter: ChessAdapter, model: Model, options: Partial<ChessPolicy> = {}, learning?: ChessLearningBinding): Promise<ChessSession> {
    const session = new ChessSession(directory, provider, adapter, model, parseChessPolicy({ ...defaultChessPolicy, ...options }), learning);
    if (await session.store.load()) throw new Error('Chess session already exists; reconnect it');
    await session.recordings.open();
    const runtime = await provider.create(`main-${randomUUID()}`, new AbortController().signal), state = await runtime.state();
    const world: SessionChessWorld = { runtime, meta: { id: runtime.id, role: 'main', status: 'paused', controller: 'ai' }, label: 'main', state,
      memory: adapter.initialMemory(state), statistics: adapter.initialStatistics(state), guidance: session.objective, provenance: session.pinLearning().provenance };
    session.worlds.register(world); session.worlds.mainId = runtime.id;
    await session.record(world); await session.recordings.retainPath(runtime.id); await session.persist();
    return session;
  }

  static async restore(directory: string, provider: ChessRuntimeStore, adapter: ChessAdapter, model: Model, learning?: ChessLearningBinding): Promise<ChessSession> {
    const saved = await new JsonFileStore(join(directory, 'session.json'), value => value as ChessSessionCheckpoint).load();
    if (!saved || ![1, 2, 3].includes(saved.version)) throw new Error('Missing or unsupported chess session');
    if ((saved.version === 1 && (saved.games || saved.pendingNewGame)) || (saved.version === 2 && !saved.games && !saved.pendingNewGame)) throw new Error('Invalid chess game history version');
    const session = new ChessSession(directory, provider, adapter, model, parseChessPolicy(saved.policy), learning);
    if (!same(saved.learning ?? null, learning?.identity ?? null)) throw new Error('Saved chess session requires its original learning supervisor');
    for (const item of [...saved.worlds, ...saved.points.points.map(point => point.data)]) session.verifyProvenance(item.provenance);
    if (saved.pendingFork) session.verifyProvenance(saved.pendingFork.baseline.provenance);
    if (saved.batch?.provenance) session.verifyProvenance(saved.batch.provenance);
    if (!same(session.provenance, saved.provenance)) throw new Error('Session components changed; explicit revision activation is required');
    const savedGoals = [...saved.worlds, ...saved.points.points.map(point => point.data), ...(saved.pendingFork ? [saved.pendingFork.baseline] : []),
      ...(saved.games?.completed ?? []).flatMap(game => game.checkpoints.map(point => point.data))].flatMap(world => world.temporaryGoal ? [world.temporaryGoal] : []);
    if (saved.version === 3) {
      if (typeof saved.goalScopeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved.goalScopeId)) throw new Error('Invalid saved chess goal scope');
      for (const goal of savedGoals) if (decodeChessTemporaryGoal(goal).record.created.scope.id !== saved.goalScopeId) throw new Error('Saved chess goal belongs to another session');
      session.goalScopeId = saved.goalScopeId;
    } else if (saved.goalScopeId || savedGoals.length) throw new Error('Chess goals require session format 3');
    await session.recordings.open();
    session.objective = saved.objective; session.points = saved.points; session.batch = saved.batch; session.pendingFork = saved.pendingFork;
    session.pendingInputs = saved.pendingInputs; session.attempts = saved.attempts; session.memory.records = saved.experiences;
    session.games = saved.games; session.pendingNewGame = saved.pendingNewGame;
    for (const item of saved.worlds) {
      const { identity, ...fields } = item;
      const runtime = identity ? await provider.connect(item.meta.id, identity, new AbortController().signal) : undefined;
      if (runtime && !session.pendingInputs[item.meta.id] && !same(await runtime.state(), item.state)) throw new Error('Unjournaled chess runtime state change');
      session.worlds.register({ ...fields, runtime });
    }
    session.worlds.mainId = saved.mainId; session.worlds.cleanup = saved.cleanup;
    for (const world of session.worlds.worlds.values()) session.advanceGoal(world);
    for (const [id, pending] of Object.entries(session.pendingInputs)) {
      const world = session.worlds.world(id), actual = await world.runtime!.state();
      const expected = new ChessWorld('validate-input', pending.before); const after = await expected.step({ san: pending.san });
      if (same(actual, pending.before)) await world.runtime!.step({ san: pending.san });
      else if (!same(actual, after)) throw new Error('Interrupted chess input has an unexpected result');
      await session.observed(world, after, pending.san);
    }
    if (session.pendingFork) await session.forks.reconcile(id => provider.recover(id));
    if (session.points.pendingRestore) {
      const pending = session.points.pendingRestore, runtime = await provider.recover(pending.id);
      if (!runtime) throw new Error('Pending chess rollback runtime is missing');
      await session.checkpoints.recover(runtime, pending.pointId);
      session.advanceGoal(session.main());
    }
    session.checkpoints.reconcileCapture();
    for (const world of session.worlds.worlds.values()) if (world.runtime) await session.record(world);
    if (session.pendingNewGame) await session.finishNewGame();
    await session.persist(); await session.worlds.collect((id, identity) => provider.destroy(id, identity));
    await session.checkpoints.collect(); return session;
  }

  snapshot(): ChessSessionCheckpoint {
    const hasGoals = [...this.worlds.worlds.values(), ...this.points.points.map(point => point.data), ...(this.pendingFork ? [this.pendingFork.baseline] : []),
      ...(this.games?.completed ?? []).flatMap(game => game.checkpoints.map(point => point.data))].some(world => world.temporaryGoal);
    return structuredClone({ version: hasGoals ? 3 : this.games || this.pendingNewGame ? 2 : 1, ...(hasGoals ? { goalScopeId: this.goalScopeId } : {}), objective: this.objective, policy: this.policy, provenance: this.provenance, ...(this.learning ? { learning: this.learning.identity } : {}),
      mainId: this.worlds.mainId, worlds: [...this.worlds.worlds.values()].map(world => ({ ...data(world), ...(world.runtime ? { identity: world.runtime.identity } : {}) })),
      cleanup: this.worlds.cleanup, points: this.points, experiences: this.memory.records, pendingFork: this.pendingFork,
      batch: this.batch, pendingInputs: this.pendingInputs, attempts: this.attempts,
      ...(this.games ? { games: this.games } : {}), ...(this.pendingNewGame ? { pendingNewGame: this.pendingNewGame } : {}) });
  }
  /** New board, same learning system. Publish intent before allocation and retain the completed replay. */
  async newGame(expectedMainId: string): Promise<void> {
    await this.gate.run(async () => {
      this.healthy();
      if (this.worlds.mainId !== expectedMainId || this.batch || this.main().state.status === 'ongoing') throw new Error('Only the current finished game can be restarted');
      this.pendingNewGame = { id: `main-${randomUUID()}`, previousMainId: expectedMainId, createdAt: Date.now() };
      try { await this.persist(); await this.finishNewGame(); }
      catch (error) { this.failed = true; throw error; }
    });
  }
  private async finishNewGame(): Promise<void> {
    const pending = this.pendingNewGame!;
    if (this.worlds.mainId !== pending.previousMainId || this.batch || this.pendingFork || this.main().state.status === 'ongoing'
      || Object.keys(this.pendingInputs).length || !pending.id || pending.id === pending.previousMainId) throw new Error('Invalid pending new chess game');
    const previous = this.main(), existing = this.worlds.worlds.get(pending.id);
    const runtime = existing?.runtime ?? await this.provider.recover(pending.id) ?? await this.provider.createFrom(pending.id, { initialFen: DEFAULT_POSITION, moves: [] });
    const state = await runtime.state();
    if (state.initialFen !== DEFAULT_POSITION || state.ply !== 0 || state.moves.length || state.fen !== DEFAULT_POSITION) throw new Error('New chess game runtime is not the initial board');
    if (!existing) this.worlds.register({ runtime, meta: { id: runtime.id, role: 'experiment', status: 'paused', controller: 'ai' }, label: 'main', state,
      memory: this.adapter.initialMemory(state), statistics: this.adapter.initialStatistics(state), guidance: this.objective, provenance: this.pinLearning().provenance });
    await this.record(this.worlds.world(pending.id));
    await this.recordings.retainPath(previous.meta.id);
    await this.worlds.promote(pending.id, { stage: () => {
      const oldGames = this.games, oldPoints = this.points;
      const offset = oldGames?.attemptsAtStart ?? { plies: 0, decisions: 0, forks: 0, rollbacks: 0 };
      const attempts = { plies: this.attempts.plies - offset.plies, decisions: this.attempts.decisions - offset.decisions,
        forks: this.attempts.forks - offset.forks, rollbacks: this.attempts.rollbacks - offset.rollbacks };
      this.games = { currentId: pending.id, attemptsAtStart: { ...this.attempts }, completed: [...(oldGames?.completed ?? []),
        { endpointId: previous.meta.id, finishedAt: pending.createdAt, state: structuredClone(previous.state), attempts, checkpoints: structuredClone(oldPoints.points) }] };
      this.points = { points: [], cleanup: [...oldPoints.cleanup] }; this.pendingNewGame = undefined;
      return () => { this.games = oldGames; this.points = oldPoints; this.pendingNewGame = pending; };
    } });
  }
  async step(manual = false): Promise<void> {
    await this.gate.run(async signal => {
      this.healthy();
      try {
        this.pinned = this.pinLearning();
        if (this.batch?.provenance && !same(this.batch.provenance, this.pinned.provenance)) throw new Error('Learning revision changed during an unresolved comparison');
        this.memory.setCapacity(this.pinned.policy.memoryCapacity);
        await this.loop.cycle(signal, manual); await this.persist(); await this.collect(); }
      catch (error) { if (signal.aborted) { await this.persist(); return; } this.failed = true; throw error; }
      finally { this.pinned = undefined; }
    });
  }
  async pause(): Promise<void> { await this.gate.stop(); }
  async checkpoint(): Promise<string> { let id = ''; await this.gate.run(async () => { this.healthy(); id = (await this.checkpoints.capture()).id; }); return id; }
  async rollback(id: string): Promise<void> { await this.gate.run(async () => { this.healthy(); await this.checkpoints.restore(id); this.advanceGoal(this.main()); await this.persist(); }); }
  /** Refuse mid-decision/batch changes. The controller alone publishes its active pointer. */
  async revisionBoundary<T>(work: () => Promise<T>): Promise<T> {
    let result!: T;
    await this.gate.run(async () => {
      this.healthy();
      if (this.batch) throw new Error('Resolve the active comparison before changing learning revisions');
      this.revisionFence = true;
      try { result = await work(); } finally { this.revisionFence = false; }
    });
    return result;
  }
  supervisorContext() { return chessSessionContext(this.objective, this.policy, this.adapter.version, this.games?.currentId); }
  private effectivePolicy(): ChessPolicy { return this.pinned?.policy ?? (this.learning ? resolveChessPolicy(this.learning.current().artifact.policy).policy : this.policy); }
  private pinLearning(): PinnedLearning {
    if (!this.learning) return { policy: this.policy, provenance: this.provenance, model: this.model };
    const { activation, artifact } = this.learning.current();
    const provenance = chessLearningProvenance(activation, artifact, this.adapter.version);
    const model = this.learning.model(artifact);
    if (!same(model.version, artifact.model)) throw new Error('Chess learning model identity differs from its artifact');
    return { policy: resolveChessPolicy(artifact.policy).policy, provenance, model };
  }
  private verifyProvenance(provenance: ChessProvenance): void {
    if (!this.learning) { if (provenance.learning) throw new Error('Missing chess learning supervisor'); return; }
    if (!provenance.learning) throw new Error('Missing chess learning activation provenance');
    const expected = chessLearningProvenance(provenance.learning, this.learning.resolve(provenance.learning), this.adapter.version);
    if (!same(provenance, expected)) throw new Error('Saved chess learning provenance does not match its artifact');
  }
  async guide(objective: string): Promise<void> {
    if (this.revisionFence) throw new Error('Learning revision publication is in progress');
    if (!objective.trim() || objective.length > 2000) throw new Error('Invalid game objective');
    this.objective = objective;
    for (const world of this.worlds.worlds.values()) this.advanceGoal(world);
    await this.persist();
  }
  replay(endpointId = this.worlds.mainId) {
    if (!this.games?.completed.some(game => game.endpointId === endpointId)) this.worlds.world(endpointId);
    return this.recordings.path(endpointId);
  }
  async replayFrame(index: number, endpointId = this.worlds.mainId) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid replay frame');
    const path = await this.replay(endpointId);
    for (const segment of path.segments) {
      if (index < segment.ticks.length) return this.recordings.get(segment.worldId, segment.firstFrame + index);
      index -= segment.ticks.length;
    }
    throw new Error('Replay frame is outside the retained path');
  }
  async detach(): Promise<void> { await this.pause(); await this.recordings.flush(); await this.persist(); }
  private healthy(): void { if (this.failed || this.pendingNewGame || this.pendingFork || this.points.pendingCapture || this.points.pendingRestore || Object.keys(this.pendingInputs).length) throw new Error('Chess session failed or has pending operations; reconnect before continuing'); }
  private main(): SessionChessWorld { return this.worlds.world(this.worlds.mainId); }
  private async persist(): Promise<void> { await this.store.save(this.snapshot()); }
  private async collect(): Promise<void> {
    this.recordings.protect([...this.worlds.worlds.values()].filter(world => world.runtime).map(world => world.meta.id));
    await this.recordings.collect(); await this.checkpoints.collect();
  }
  private goalContext(world: SessionChessWorld) {
    const provenance = this.pinned?.provenance ?? this.pinLearning().provenance;
    return { player: this.adapter.player, frame: chessGoalFrame({ scopeId: this.goalScopeId, gameId: this.games?.currentId, state: world.state,
      player: this.adapter.player, objective: this.objective, source: contentRevision('chess-goal-strategy', provenance) }),
      ...(world.temporaryGoal ? { current: world.temporaryGoal } : {}) };
  }
  private advanceGoal(world: SessionChessWorld) {
    if (world.temporaryGoal?.record.status === 'active') world.temporaryGoal = advanceChessTemporaryGoal(world.temporaryGoal, this.goalContext(world).frame, world.state, this.adapter.player);
  }
  private async judge(world: SessionChessWorld, signal: AbortSignal): Promise<Judgment> {
    const judged = await decideCurrent({
      capture: () => ({ objective: this.objective }),
      decide: async (capture, current) => {
        const plans = await this.adapter.candidates(world.state), model = this.pinned!.model;
        this.attempts.decisions++;
        this.advanceGoal(world);
        const request: ChessDecisionRequest = { temporaryGoal: this.goalContext(world), state: structuredClone(world.state), objective: capture.objective,
          candidates: structuredClone(plans), experience: this.memory.relevant(world.state, 4), revision: this.pinned!.provenance.learning?.revision ?? this.pinned!.provenance.policy };
        return decideChess(model, request, current);
      },
      isCurrent: capture => capture.objective === this.objective,
    }, signal);
    const { plans, answer, temporaryGoal } = structuredClone(judged.result);
    if (temporaryGoal) { world.temporaryGoal = advanceChessTemporaryGoal(temporaryGoal, this.goalContext(world).frame, world.state, this.adapter.player); await this.persist(); }

    return { confidence: answer.confidence, candidates: answer.preferences.map(preference => ({ probability: preference.probability, plan: plans.find(plan => plan.id === preference.id)! })), data: { selected: plans.find(plan => plan.id === answer.selected)!, objective: judged.context.objective } };
  }
  private async advance(world: SessionChessWorld, plan: PlanDefinition<ChessPlan>, signal: AbortSignal, objective: string): Promise<void> {
    signal.throwIfAborted();
    if (objective !== this.objective) return;
    const execution = this.adapter.start(plan), next = await this.adapter.next(execution);
    if (next.status.status !== 'running' || !next.command) return;
    signal.throwIfAborted();
    // A guide edit can replace the proposed opening before its first dispatch.
    if (this.batch?.ids.includes(world.meta.id) && world.state.ply === this.batch.baseline.ply) world.label = plan.label;
    this.pendingInputs[world.meta.id] = { before: structuredClone(world.state), san: next.command.san };
    this.attempts.plies++; world.guidance = objective; world.provenance = structuredClone(this.pinned!.provenance); delete world.opening;
    await this.persist(); // Command intent makes an interrupted step recoverable without double input.
    const state = await world.runtime!.step(next.command);
    await this.observed(world, state, next.command.san);
  }
  private async observed(world: SessionChessWorld, state: ChessState, action: string): Promise<void> {
    const before = world.state;
    this.adapter.observe(before, state, world.memory, world.statistics); this.memory.remember(world.meta.id, action, before, state);
    world.state = state; this.advanceGoal(world); world.meta.status = state.status === 'ongoing' ? 'paused' : 'ended'; delete this.pendingInputs[world.meta.id];
    await this.record(world); await this.persist();
  }
  private async explore(signal: AbortSignal): Promise<void> {
    const batch = this.batch!;
    await runTrials(batch.ids.map(id => {
      const world = this.worlds.world(id);
      return { id, baseline: this.adapter.clock(batch.baseline), duration: { amount: batch.plies, unit: 'turns' as const },
        clock: () => this.adapter.clock(world.state), terminal: () => world.state.status !== 'ongoing',
        advance: async (_remaining, current) => {
          const choice = world.opening && world.guidance === this.objective ? { selected: world.opening, objective: world.guidance } : (await this.judge(world, current)).data;
          await this.advance(world, choice.selected, current, choice.objective);
        } };
    }), signal);
    if (!signal.aborted) {
      for (const id of batch.ids) { const world = this.worlds.world(id); this.memory.remember(id, world.label, batch.baseline, world.state); }
      batch.complete = true;
    }
    await this.persist();
  }
  private async record(world: SessionChessWorld): Promise<void> {
    this.recordings.protect([...this.worlds.worlds.values()].filter(item => item.runtime).map(item => item.meta.id).concat(world.meta.id));
    const last = this.recordings.list().worlds.find(entry => entry.id === world.meta.id)?.lastTick;
    if (last !== undefined && last >= world.state.ply) return;
    const frame = await world.runtime!.frame();
    await this.recordings.record({ ...data(world), id: world.meta.id }, Buffer.from(frame));
    if (this.recordings.error) throw new Error(this.recordings.error);
  }
}
function data(world: SessionChessWorld): ChessWorldData { const { runtime: _runtime, ...value } = world; return structuredClone(value); }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
/** A new game invalidates old in-flight advice without discarding learned revisions. */
export function chessSessionContext(objective: string, profile: ChessPolicy, adapter: ChessProvenance['adapter'], gameId?: string) {
  return contentRevision('chess-user-context', { objective, profile, adapter, ...(gameId ? { gameId } : {}) });
}
