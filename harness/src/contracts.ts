/** Stable identity of an adapter, model, policy or executable artifact. */
export interface VersionRef { id: string; version: string }

/** Simulation time is independent of wall time and model latency. */
export interface GameClock {
  sequence: number;
  elapsed: number;
  unit: 'seconds' | 'turns';
}
export interface Duration { amount: number; unit: GameClock['unit'] }
export interface ObservationFact<T> {
  value: T;
  provenance: 'observed' | 'inferred' | 'stale' | 'unavailable';
  sequence: number;
  source: string;
}
export interface GameCapabilities {
  observations: 'structured' | 'visual' | 'mixed';
  exactFork: boolean;
  checkpoint: boolean;
  restore: boolean;
  detached: boolean;
  render: boolean;
}
export type Capability = keyof Omit<GameCapabilities, 'observations'>;

/** Runtime lifecycle; command and observation semantics belong to the adapter. */
export interface WorldRuntime<State, Command, Frame = Uint8Array | undefined> {
  readonly id: string;
  readonly identity: string;
  state(): Promise<State>;
  step(command: Command): Promise<State>;
  frame(): Promise<Frame>;
  branch?(ids: string[]): Promise<Array<WorldRuntime<State, Command, Frame>>>;
  destroy(): Promise<void>;
  captureCheckpoint?(reference: string): Promise<void>;
}
export interface RuntimeProvider<State, Command, Frame = Uint8Array | undefined> {
  readonly version: VersionRef;
  readonly capabilities: GameCapabilities;
  create(id: string, signal: AbortSignal): Promise<WorldRuntime<State, Command, Frame>>;
  connect(id: string, identity: string, signal: AbortSignal): Promise<WorldRuntime<State, Command, Frame>>;
  restore?(reference: string, id: string, signal: AbortSignal): Promise<WorldRuntime<State, Command, Frame>>;
  removeCheckpoint?(reference: string): Promise<void>;
}
export interface PlanDefinition<Payload> {
  id: string;
  version: string;
  label: string;
  payload: Payload;
  requires: Capability[];
  evidence: { sequence: number; description: string };
  expectedBenefit: string;
  maxDuration: Duration;
  sideEffects: string[];
}
export interface PlanStatus {
  status: 'running' | 'complete' | 'interrupted' | 'failed';
  reason?: string;
  step?: string;
}
export interface MeasuredOutcome {
  metrics: Readonly<Record<string, number>>;
  terminal: 'ongoing' | 'success' | 'failure';
  progress: boolean;
}
/** Adapter supplies executable mechanics, never session lifecycle or model calls. */
export interface GameAdapter<State, Command, Plan, Execution, Memory, Statistics> {
  readonly version: VersionRef;
  clock(state: State): GameClock;
  episode(state: State): string;
  terminal(state: State): MeasuredOutcome['terminal'];
  initialMemory(state: State): Memory;
  initialStatistics(state: State): Statistics;
  observe(before: State, after: State, memory: Memory, stats: Statistics): void;
  candidates(state: State, memory: Readonly<Memory>, objective: string): Promise<Array<PlanDefinition<Plan>>>;
  start(plan: PlanDefinition<Plan>, state: State, budget: Duration): Execution;
  next(execution: Execution, state: State, memory: Memory): Promise<{ status: PlanStatus; command?: Command }>;
  measure(before: State, after: State, stats: Statistics): MeasuredOutcome;
}
export interface DecisionRequest<State, Plan, Evidence> {
  state: State;
  objective: string;
  candidates: ReadonlyArray<PlanDefinition<Plan>>;
  experience: ReadonlyArray<Evidence>;
  revision: VersionRef;
}
export interface RankedChoice {
  selected: string;
  preferences: Array<{ id: string; probability: number }>;
  confidence: number;
  usage: { calls: number; inputTokens?: number; outputTokens?: number; cost?: number };
}
export interface DecisionModel<State, Plan, Evidence> {
  readonly version: VersionRef;
  decide(request: DecisionRequest<State, Plan, Evidence>, signal: AbortSignal): Promise<RankedChoice>;
}
export interface CheckpointStore<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
  flush(): Promise<void>;
}
export interface HarnessEvent<T = unknown> {
  id: string;
  sessionId: string;
  at: number;
  type: string;
  revision: VersionRef;
  payload: T;
}
export interface EventStore {
  append(event: HarnessEvent): Promise<void>;
  scan(sessionId: string, afterId?: string): AsyncIterable<HarnessEvent>;
}
