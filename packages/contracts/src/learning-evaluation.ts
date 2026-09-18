/** Read-only spectator projection. Frames are saved observations, not continuous video. */
export interface EvaluationWorldPreview {
  id: string; label: string; role: 'main' | 'experiment'; tick: number;
  health: number; kills: number; frame?: string;
}
export interface EvaluationRunPreview {
  id: string; scenarioId: string; role: 'baseline' | 'candidate';
  status: 'waiting' | 'running' | 'complete' | 'error' | 'cancelled' | 'timeout' | 'interrupted' | 'not-run';
  updatedAt?: number; stage?: string; error?: string; ending?: string;
  stats?: { health: number; armor: number; kills: number; items: number; cells: number; seconds: number; damage: number };
  metrics?: Record<string, number>;
  options?: { generated: boolean; entries: Array<{ label: string; probability: number; tested: boolean }> };
  worlds: EvaluationWorldPreview[];
}
export interface LearningEvaluationView {
  proposalId: string; active: boolean; total: number; finished: number;
  scenarios: string[]; runs: EvaluationRunPreview[];
}
