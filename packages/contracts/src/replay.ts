/** A fixed view of retained footage along one world's ancestry. */
export interface ReplayPath {
  endpointId: string;
  segments: Array<{ worldId: string; label: string; firstFrame: number; ticks: number[] }>;
  frames: number;
  firstTick: number;
  lastTick: number;
  missingHistory: boolean;
}
