import { canonicalJson, type EvaluationComparison, type EvaluationContract } from '@multiverse/gameplay-harness';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';

export interface ChessSampleGroup {
  /** Private case identity. Never sent to the supervisor. */
  id: string; index: number; count: number;
  minimumMeanGain?: number; minimumImprovedPairs?: number;
}
export interface ChessSampleSummary {
  plannedPairs: number; completedPairs: number;
  positions: Array<{ planned: number; completed: number; mean?: number; min?: number; max?: number; improved: number; tied: number; worse: number;
    baseline?: { mean: number; min: number; max: number }; candidate?: { mean: number; min: number; max: number } }>;
}

/** Validate declared repetitions before spending anything. Repeats must restore the same full history and allowances. */
export function chessSampleGroups(contract: EvaluationContract<ChessStrategyScenario>) {
  const groups = new Map<string, { sample?: ChessSampleGroup; scenarios: typeof contract.scenarios }>();
  for (const scenario of contract.scenarios) {
    const sample = scenario.input.sample;
    if (sample && (!sample.id.trim() || !Number.isSafeInteger(sample.count) || sample.count < 2 || !Number.isSafeInteger(sample.index)
      || sample.index < 0 || sample.index >= sample.count
      || (sample.minimumMeanGain !== undefined && (!Number.isFinite(sample.minimumMeanGain) || sample.minimumMeanGain < 0))
      || (sample.minimumImprovedPairs !== undefined && (!Number.isSafeInteger(sample.minimumImprovedPairs) || sample.minimumImprovedPairs < 1 || sample.minimumImprovedPairs > sample.count)))) throw new Error('Invalid chess sample requirement');
    const key = sample ? `sample:${sample.id}` : `single:${scenario.id}`;
    const group = groups.get(key) ?? { sample, scenarios: [] };
    group.scenarios.push(scenario); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.sample) {
    if (group.scenarios.length !== group.sample.count) throw new Error('Chess repetition group is incomplete');
    const inputs = group.scenarios.map(scenario => {
      const { sample, ...input } = scenario.input;
      const { index: _index, ...requirement } = sample!;
      return canonicalJson({ input, requirement });
    });
    if (new Set(group.scenarios.map(scenario => scenario.input.sample!.index)).size !== group.sample.count || new Set(inputs).size !== 1) throw new Error('Chess repetitions differ in history, limits or requirements');
  }
  return [...groups.values()];
}

/** Descriptive evidence only: these small, unseeded model samples do not justify a statistical-confidence claim. */
export function summarizeChessComparison(report: EvaluationComparison<ChessStrategyScenario, ChessStrategyEvaluationEvidence>): ChessSampleSummary {
  const direction = report.contract.acceptance.direction === 'maximize' ? 1 : -1;
  const positions = chessSampleGroups(report.contract).map(group => {
    const gains: number[] = [], baseline: number[] = [], candidate: number[] = [];
    for (const scenario of group.scenarios) {
      const runs = report.runs.filter(run => run.scenarioId === scenario.id);
      const before = runs.filter(run => run.role === 'baseline'), after = runs.filter(run => run.role === 'candidate');
      if (before.length > 1 || after.length > 1 || runs.length > 2) throw new Error('Duplicate chess comparison samples');
      if (before[0]?.status !== 'complete' || after[0]?.status !== 'complete') continue;
      for (const run of [before[0], after[0]]) {
        if (run.seed !== scenario.seed || canonicalJson(run.revision) !== canonicalJson(run.role === 'baseline' ? report.baseline : report.candidate)) throw new Error('Chess comparison sample identity mismatch');
      }
      const a = before[0].metrics?.[report.contract.acceptance.metric], b = after[0].metrics?.[report.contract.acceptance.metric];
      if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Missing chess comparison sample metrics');
      const gain = (b - a) * direction;
      if (!Number.isFinite(gain)) throw new Error('Chess comparison sample overflow');
      gains.push(gain);
      baseline.push(a); candidate.push(b);
    }
    return { planned: group.scenarios.length, completed: gains.length,
      ...(gains.length ? { ...range(gains), baseline: range(baseline), candidate: range(candidate) } : {}),
      improved: gains.filter(gain => gain > 0).length, tied: gains.filter(gain => gain === 0).length, worse: gains.filter(gain => gain < 0).length };
  });
  return { plannedPairs: report.contract.scenarios.length, completedPairs: positions.reduce((sum, position) => sum + position.completed, 0), positions };
}
function range(values: number[]) { return { mean: values.reduce((sum, value) => sum + value / values.length, 0), min: Math.min(...values), max: Math.max(...values) }; }
