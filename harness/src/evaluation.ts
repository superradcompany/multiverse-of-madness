import type { VersionRef } from './contracts.ts';
import { BudgetLedger, budgetResources, type BudgetSnapshot, type BudgetSpec } from './budget.ts';
import { canonicalJson } from './policy.ts';

export interface EvaluationScenario<Input> { id: string; seed: string; input: Input }
export interface EvaluationContract<Input> {
  id: string;
  evaluator: VersionRef;
  scenarios: Array<EvaluationScenario<Input>>;
  budget: BudgetSpec;
  maxRunMs: number;
  acceptance: { metric: string; direction: 'maximize' | 'minimize'; minimumMeanGain: number; maximumCaseRegression: number };
}
export interface EvaluationOutput<Evidence> { evidence: Evidence; ending: 'terminal' | 'budget' | 'complete' }
export interface EvaluationRun<Evidence> {
  id: string;
  role: 'baseline' | 'candidate';
  revision: VersionRef;
  scenarioId: string;
  seed: string;
  status: 'complete' | 'error' | 'cancelled' | 'timeout';
  ending?: EvaluationOutput<Evidence>['ending'];
  evidence?: Evidence;
  metrics?: Record<string, number>;
  error?: string;
  budget: BudgetSnapshot;
}
export interface EvaluationPorts<Input, Evidence> {
  /** Trusted host adapter meters all candidate work; executable revisions only receive bounded tools. */
  run(revision: VersionRef, scenario: EvaluationScenario<Input>, budget: BudgetLedger, signal: AbortSignal): Promise<EvaluationOutput<Evidence>>;
  /** Independent evaluator; revisions must not supply or change this function. */
  measure(evidence: Evidence): Record<string, number>;
  persistBudget?(runId: string, snapshot: BudgetSnapshot): Promise<void>;
  /** Optional host-owned early rejection after both runs have joined and been persisted.
   * This can only reject, never qualify incomplete comparisons. Its meaning belongs to contract.evaluator.
   */
  rejectAfterPair?(scenario: EvaluationScenario<Input>, runs: ReadonlyArray<EvaluationRun<Evidence>>): string | undefined;
  persistRun?(run: EvaluationRun<Evidence>): Promise<void>;
}
export interface EvaluationComparison<Input, Evidence> {
  contract: EvaluationContract<Input>;
  baseline: VersionRef;
  candidate: VersionRef;
  runs: Array<EvaluationRun<Evidence>>;
  gains: Array<{ scenarioId: string; gain: number }>;
  meanGain?: number;
  accepted: boolean;
  reason: string;
}

/** Paired, fixed-scenario comparison under identical total budgets for each run. */
export async function compareRevisions<Input, Evidence>(contract: EvaluationContract<Input>, baseline: VersionRef, candidate: VersionRef,
  ports: EvaluationPorts<Input, Evidence>, signal: AbortSignal): Promise<EvaluationComparison<Input, Evidence>> {
  contract = copy(contract); baseline = copy(baseline); candidate = copy(candidate);
  validate(contract, baseline, candidate);
  const runs: Array<EvaluationRun<Evidence>> = [];
  let rejection: string | undefined;
  for (const [index, scenario] of contract.scenarios.entries()) {
    // Alternate order across scenarios to reduce consistent first-run effects.
    const order = index % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
    for (const role of order) {
      if (signal.aborted) break;
      const revision = role === 'baseline' ? baseline : candidate;
      const id = `${contract.id}/${scenario.id}/${role}`;
      const budget = new BudgetLedger(contract.budget, snapshot => ports.persistBudget?.(id, snapshot) ?? Promise.resolve());
      const control = new AbortController();
      const cancel = () => control.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; control.abort(new Error('Evaluation deadline reached')); }, contract.maxRunMs);
      const run: EvaluationRun<Evidence> = { id, role, revision: copy(revision), scenarioId: scenario.id, seed: scenario.seed, status: 'complete', budget: budget.snapshot() };
      try {
        const output = await ports.run(copy(revision), copy(scenario), budget, control.signal);
        control.signal.throwIfAborted();
        if (!['terminal', 'budget', 'complete'].includes(output.ending)) throw new Error('Invalid evaluation ending');
        const evidence = copy(output.evidence);
        const metrics = ports.measure(copy(evidence));
        if (!metrics || !Object.hasOwn(metrics, contract.acceptance.metric) || Object.values(metrics).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Evaluator returned invalid or missing metrics');
        run.ending = output.ending; run.evidence = evidence; run.metrics = copy(metrics);
      } catch (error) {
        run.status = timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'error';
        run.error = error instanceof Error ? error.message : 'Evaluation failed';
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        const detached = budget.pending > 0;
        budget.seal();
        if (detached) control.abort(new Error('Evaluation returned with unfinished work'));
        await budget.join();
        if (detached) { run.status = 'error'; run.error = 'Evaluation returned with unfinished work'; }
        run.budget = budget.snapshot();
      }
      if (run.budget.entries.some(entry => entry.status === 'pending' || entry.status === 'overrun')) {
        run.status = 'error'; run.error = 'Evaluation left pending work or exceeded an operation reservation';
      }
      for (const resource of budgetResources) if (budget.used(resource) > (contract.budget.limits[resource] ?? Infinity)) {
        run.status = 'error'; run.error = `Evaluation exceeded total ${resource} budget`;
      }
      await ports.persistRun?.(copy(run));
      runs.push(run);
    }
    if (signal.aborted) break;
    rejection = ports.rejectAfterPair?.(copy(scenario), copy(runs.filter(run => run.scenarioId === scenario.id)));
    if (rejection !== undefined) {
      if (typeof rejection !== 'string' || !rejection.trim()) throw new Error('Early evaluation rejection requires a reason');
      break;
    }
  }
  const result: EvaluationComparison<Input, Evidence> = { contract, baseline, candidate, runs, gains: [], accepted: false, reason: rejection ?? 'Evaluation did not complete every paired scenario' };
  const direction = contract.acceptance.direction === 'maximize' ? 1 : -1;
  for (const scenario of contract.scenarios) {
    const before = runs.find(run => run.scenarioId === scenario.id && run.role === 'baseline');
    const after = runs.find(run => run.scenarioId === scenario.id && run.role === 'candidate');
    if (before?.status !== 'complete' || after?.status !== 'complete') continue;
    const gain = direction * (after.metrics![contract.acceptance.metric]! - before.metrics![contract.acceptance.metric]!);
    if (!Number.isFinite(gain)) throw new Error('Evaluation gain overflow');
    result.gains.push({ scenarioId: scenario.id, gain });
  }
  // Completed pairs remain evidence even when a later pair is missing or the host rejects early.
  // Never report their partial mean as the full contract's mean, or accept incomplete work.
  if (rejection !== undefined || runs.length !== contract.scenarios.length * 2 || runs.some(run => run.status !== 'complete')) return result;
  result.meanGain = result.gains.reduce((sum, pair) => sum + pair.gain / result.gains.length, 0);
  if (!Number.isFinite(result.meanGain)) throw new Error('Evaluation mean overflow');
  if (result.gains.some(pair => pair.gain < -contract.acceptance.maximumCaseRegression)) result.reason = 'Candidate exceeded the allowed regression on a scenario';
  else if (result.meanGain < contract.acceptance.minimumMeanGain) result.reason = 'Candidate did not reach the required mean improvement';
  else { result.accepted = true; result.reason = 'Candidate met the fixed acceptance contract on every required scenario'; }
  return result;
}
function copy<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function validate<Input>(contract: EvaluationContract<Input>, baseline: VersionRef, candidate: VersionRef): void {
  for (const revision of [contract.evaluator, baseline, candidate]) if (!revision?.id?.trim() || !revision.version?.trim()) throw new Error('Evaluation requires explicit component versions');
  if (!contract.id?.trim() || !contract.scenarios.length || new Set(contract.scenarios.map(s => s.id)).size !== contract.scenarios.length
    || contract.scenarios.some(s => !s.id?.trim() || typeof s.seed !== 'string' || !s.seed.length)) throw new Error('Evaluation requires unique scenarios and explicit seeds');
  if (!Number.isSafeInteger(contract.maxRunMs) || contract.maxRunMs < 1 || contract.maxRunMs > 2147483647) throw new Error('Invalid evaluation deadline');
  const rule = contract.acceptance;
  if (!rule.metric?.trim() || !['maximize', 'minimize'].includes(rule.direction) || !Number.isFinite(rule.minimumMeanGain) || rule.minimumMeanGain < 0
    || !Number.isFinite(rule.maximumCaseRegression) || rule.maximumCaseRegression < 0) throw new Error('Invalid independent acceptance rule');
  new BudgetLedger(contract.budget);
  if (contract.budget.limits.simulation === undefined || contract.budget.limits.modelCalls === undefined) throw new Error('Matched evaluation requires total simulation and model-call limits');
}
