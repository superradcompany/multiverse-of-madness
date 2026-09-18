import { routeDecision, type RoutingContext, type RoutingPolicy, type WeightedCandidate } from './routing.ts';

export type LearningStage = 'ready' | 'deciding' | 'acting' | 'forking' | 'exploring' | 'choosing' | 'continuing';
export type BatchPhase = 'none' | 'exploring' | 'complete';
export interface LoopLimits { breadth: number }
export interface LoopJudgment<Candidate extends WeightedCandidate, Data> {
  confidence: number;
  candidates: Candidate[];
  data: Data;
}
export type RoutedJudgment<Candidate extends WeightedCandidate> = ReturnType<typeof routeDecision<Candidate>>;
export interface LearningLoopPorts<World, Candidate extends WeightedCandidate, Data, Limits extends LoopLimits> {
  state: {
    main(): World;
    terminal(world: World): boolean;
    batch(): BatchPhase;
  };
  planning: {
    /** Apply current instructions and invalidate a continuation if appropriate. */
    prepare(world: World, manual: boolean): void;
    continuing(world: World): boolean;
    continue(world: World, signal: AbortSignal): Promise<void>;
    /** Serializable limits are pinned before asking the decision provider. */
    limits(): Limits;
    decide(world: World, limits: Limits, signal: AbortSignal): Promise<LoopJudgment<Candidate, Data>>;
    routing(world: World): Pick<RoutingPolicy, 'threshold'> & Pick<RoutingContext, 'stalled' | 'retries'>;
    execute(world: World, judgment: LoopJudgment<Candidate, Data>, limits: Limits, signal: AbortSignal): Promise<void>;
  };
  comparison: {
    explore(signal: AbortSignal): Promise<void>;
    evaluate(): { winner?: World; rejected: boolean };
    create(source: World, candidates: Candidate[], judgment: LoopJudgment<Candidate, Data>, limits: Limits, signal: AbortSignal): Promise<void>;
    promote(world: World): Promise<void>;
    /** Optional presentation pacing; it must fence cancellation before returning. */
    review?(world: World, signal: AbortSignal): Promise<void>;
    afterPromotion?(signal: AbortSignal): Promise<void>;
  };
  recovery: {
    checkpointNeeded(world: World): boolean;
    checkpoint(): Promise<void>;
    terminal(world: World): Promise<void>;
    reject(signal: AbortSignal): Promise<void>;
  };
  observe?: {
    stage?(stage: LearningStage): void;
    decision?(world: World, judgment: LoopJudgment<Candidate, Data>, routing: RoutedJudgment<Candidate>, limits: Limits): void;
  };
}

/**
 * One shared decision/trial/selection cycle. Domain ports supply observations,
 * executable plans and outcome policy; they do not choose the workflow order.
 * The session's execution gate owns repeated cycles and manual-control exclusion.
 */
export class LearningLoop<World, Candidate extends WeightedCandidate, Data, Limits extends LoopLimits> {
  constructor(private readonly ports: LearningLoopPorts<World, Candidate, Data, Limits>) {}

  async cycle(signal: AbortSignal, manual = false): Promise<'advanced' | 'stopped' | 'cancelled'> {
    if (signal.aborted) return 'cancelled';
    const { state, planning, comparison, recovery, observe } = this.ports;
    const stage = (value: LearningStage) => observe?.stage?.(value);
    const batch = state.batch();
    if (batch !== 'none') {
      if (batch === 'exploring') {
        await comparison.explore(signal);
      } else {
        const result = comparison.evaluate();
        if (result.rejected) { await recovery.reject(signal); return signal.aborted ? 'cancelled' : 'advanced'; }
        if (!result.winner) throw new Error('No eligible trial outcome is available for promotion');
        if (!manual) await comparison.review?.(result.winner, signal);
        if (signal.aborted) return 'cancelled';
        await comparison.promote(result.winner);
        if (!manual && !signal.aborted) {
          stage('continuing');
          await comparison.afterPromotion?.(signal);
          stage('ready');
        }
      }
      return signal.aborted ? 'cancelled' : 'advanced';
    }
    const main = state.main();
    if (state.terminal(main)) { await recovery.terminal(main); return 'stopped'; }
    if (recovery.checkpointNeeded(main)) {
      await recovery.checkpoint();
      if (signal.aborted) return 'cancelled';
    }
    planning.prepare(main, manual);
    if (signal.aborted) return 'cancelled';
    if (planning.continuing(main)) {
      stage('acting');
      if (signal.aborted) return 'cancelled';
      await planning.continue(main, signal); stage('ready');
      return signal.aborted ? 'cancelled' : 'advanced';
    }
    stage('deciding');
    if (signal.aborted) return 'cancelled';
    const limits = structuredClone(planning.limits());
    const judgment = await planning.decide(main, limits, signal);
    if (signal.aborted) return 'cancelled';
    const context = planning.routing(main);
    const routing = routeDecision(judgment.candidates, { threshold: context.threshold, breadth: limits.breadth }, {
      confidence: judgment.confidence, manual, stalled: context.stalled, retries: context.retries,
    });
    observe?.decision?.(main, judgment, routing, limits);
    if (signal.aborted) return 'cancelled';
    if (routing.mode === 'direct') {
      stage('acting');
      if (signal.aborted) return 'cancelled';
      await planning.execute(main, judgment, limits, signal); stage('ready');
    } else {
      stage('forking');
      if (signal.aborted) return 'cancelled';
      await comparison.create(main, routing.trials, judgment, limits, signal);
      stage('exploring');
      if (!signal.aborted) await comparison.explore(signal);
    }
    return signal.aborted ? 'cancelled' : 'advanced';
  }
}
