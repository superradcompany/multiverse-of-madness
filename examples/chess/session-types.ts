import type { ActivationRef, CheckpointJournal, CheckpointRecord, ForkIntent, PlanDefinition, VersionRef, WorldMetadata, RuntimeReference } from '@multiverse/gameplay-harness';
import type { ChessExperience, ChessMemory, ChessPlan, ChessStatistics } from './adapter.ts';
import type { ChessState } from './runtime.ts';
import type { StoredChessWorld } from './runtime-store.ts';

export interface ChessPolicy { threshold: number; breadth: number; trialPlies: number; checkpointEvery: number; checkpointLimit: number; memoryCapacity: number }
export interface ChessProvenance { adapter: VersionRef; model: VersionRef; policy: VersionRef; executor?: VersionRef; learning?: ActivationRef }
export interface ChessWorldData {
  meta: WorldMetadata;
  label: string;
  parentId?: string;
  state: ChessState;
  memory: ChessMemory;
  statistics: ChessStatistics;
  provenance: ChessProvenance;
  guidance: string;
  opening?: PlanDefinition<ChessPlan>;
}
export interface SessionChessWorld extends ChessWorldData { runtime?: StoredChessWorld }
export interface ChessPoint extends CheckpointRecord { worldId: string; data: ChessWorldData }
export interface ChessFork extends ForkIntent { baseline: ChessWorldData; objective: string; plans: Array<PlanDefinition<ChessPlan>>; plies: number }
export interface ChessBatch { ids: string[]; baseline: ChessState; plies: number; complete: boolean; provenance?: ChessProvenance }
export interface PendingChessInput { before: ChessState; san: string }
export interface ChessCompletedGame {
  endpointId: string;
  finishedAt: number;
  state: ChessState;
  attempts: ChessSessionCheckpoint['attempts'];
  checkpoints: ChessPoint[];
}
export interface ChessGames {
  currentId: string;
  attemptsAtStart: ChessSessionCheckpoint['attempts'];
  completed: ChessCompletedGame[];
}
export interface PendingChessGame { id: string; previousMainId: string; createdAt: number }
export interface ChessSessionCheckpoint {
  version: 1 | 2;
  objective: string;
  policy: ChessPolicy;
  provenance: ChessProvenance;
  learning?: VersionRef;
  mainId: string;
  worlds: Array<ChessWorldData & { identity?: string }>;
  cleanup: RuntimeReference[];
  points: CheckpointJournal<ChessPoint>;
  experiences: ChessExperience[];
  pendingFork?: ChessFork;
  batch?: ChessBatch;
  pendingInputs: Record<string, PendingChessInput>;
  attempts: { plies: number; decisions: number; forks: number; rollbacks: number };
  /** Version 2 starts only when a new game is requested; version 1 history stays readable. */
  games?: ChessGames;
  pendingNewGame?: PendingChessGame;
}
