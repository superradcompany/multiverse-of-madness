/** Retained ancestry. `ticks` are opaque monotonic game positions, not seconds. */
export interface ReplayPath {
  endpointId: string;
  segments: Array<{ worldId: string; label: string; firstFrame: number; ticks: number[] }>;
  frames: number;
  firstTick: number;
  lastTick: number;
  missingHistory: boolean;
}
