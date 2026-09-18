import { compareRevisions, canonicalJson, type BudgetLedger, type EvaluationComparison, type EvaluationContract, type EvaluationPorts, type LearningRevision } from '@multiverse/gameplay-harness';
import { ChessAdapter, type ChessExperience } from './adapter.ts';
import { ChessWorld, type ChessSave, type ChessState } from './runtime.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessDecisionModel } from './revisions.ts';
import { decideChess } from './decision.ts';
import { chessSampleGroups, summarizeChessComparison, type ChessSampleGroup } from './comparison-summary.ts';

/** Host-pinned history is necessary: a FEN alone loses repetition information. */
export interface ChessStrategyScenario {
  saved: ChessSave; objective: string; player: 'w' | 'b'; plies: number;
  /** Host-owned incident gate: gains elsewhere cannot compensate for failing this position. */
  minimumGain?: number;
  /** Host-declared repeated samples; not exposed to executable strategies or the decision model. */
  sample?: ChessSampleGroup;
}
export interface ChessStrategyEvaluationEvidence {
  player: 'w' | 'b'; before: ChessState; after: ChessState;
  moves: Array<{ before: ChessState; after: ChessState; selected: string; actor: 'strategy' | 'opponent' }>;
}
type Persistence = Pick<EvaluationPorts<ChessStrategyScenario, ChessStrategyEvaluationEvidence>, 'persistBudget' | 'persistRun'>;

/** Evaluate strategy/Jev play against the same frozen opponent, without touching a live session.
 * This measures single-path strategy quality, not the session's future-search policy or full-game strength.
 * The model factory must use the supplied ledger for isolated preparation; calls and plies are metered here.
 */
export async function compareChessStrategies(options: {
  contract: EvaluationContract<ChessStrategyScenario>;
  baseline: LearningRevision<ChessPolicy>; candidate: LearningRevision<ChessPolicy>;
  model(artifact: LearningRevision<ChessPolicy>, ledger: BudgetLedger, runId: string): Promise<ChessDecisionModel>;
  persistence?: Persistence;
  /** Recovery audits need all matched cases even when the incident fails early. */
  completeAllPairs?: boolean;
}, signal: AbortSignal) {
  const { contract, baseline, candidate } = structuredClone({ contract: options.contract, baseline: options.baseline, candidate: options.candidate });
  if (canonicalJson(baseline.adapter) !== canonicalJson(candidate.adapter)) throw new Error('Chess comparison adapters differ');
  chessSampleGroups(contract);
  for (const { input } of contract.scenarios) {
    if (!['w', 'b'].includes(input.player) || !input.objective.trim() || !Number.isSafeInteger(input.plies) || input.plies < 1
      || contract.budget.limits.simulation !== input.plies || contract.budget.limits.modelCalls !== input.plies) throw new Error('Chess comparison requires matching ply and decision allowances');
    if (input.minimumGain !== undefined && (!Number.isFinite(input.minimumGain) || input.minimumGain < 0)) throw new Error('Invalid chess scenario improvement gate');
    if (canonicalJson(new ChessAdapter(input.player).version) !== canonicalJson(baseline.adapter)) throw new Error('Chess comparison player does not match adapter');
  }
  const report = await compareRevisions(contract, baseline.revision, candidate.revision, {
    ...options.persistence,
    run: async (ref, scenario, ledger, current) => {
      const artifact = [baseline, candidate].find(item => canonicalJson(item.revision) === canonicalJson(ref));
      if (!artifact) throw new Error('Unknown chess strategy revision');
      const { input } = scenario, adapter = new ChessAdapter(input.player);
      const runId = `${scenario.id}/${canonicalJson(ref) === canonicalJson(baseline.revision) ? 'baseline' : 'candidate'}`;
      const world = new ChessWorld(runId, input.saved);
      try {
        const before = await world.state(), moves: ChessStrategyEvaluationEvidence['moves'] = [], experience: ChessExperience[] = [];
        let after = before;
        // Separate model objects/journals per run and role; the opponent always uses the baseline artifact.
        const strategy = await options.model(structuredClone(artifact), ledger, `${runId}/strategy`);
        const opponent = await options.model(structuredClone(baseline), ledger, `${runId}/opponent`);
        for (let ply = 0; ply < input.plies && after.status === 'ongoing'; ply++) {
          current.throwIfAborted();
          const state = after, ownTurn = state.turn === input.player;
          const result = await ledger.run({ owner: runId, operation: 'evaluation-decision', reserve: { modelCalls: 1 } }, async () => ({
            value: await decideChess(ownTurn ? strategy : opponent, { state, objective: input.objective,
              candidates: await adapter.candidates(state), experience: structuredClone(experience.filter(item => item.fen === state.fen).slice(-4)), revision: (ownTurn ? artifact : baseline).revision }, current),
            usage: { modelCalls: 1 },
          }), current);
          const plan = result.plans.find(item => item.id === result.answer.selected)!;
          after = await ledger.run({ owner: runId, operation: 'evaluation-move', reserve: { simulation: 1 } }, async () => ({
            value: await world.step(plan.payload), usage: { simulation: 1 },
          }), current);
          moves.push({ before: state, after, selected: plan.id, actor: ownTurn ? 'strategy' : 'opponent' });
          const observed = adapter.evidence().capture(runId, plan.id, state, after);
          if (observed) experience.push(observed);
        }
        return { ending: after.status === 'ongoing' ? 'budget' : 'terminal', evidence: { player: input.player, before, after, moves } };
      } finally { await world.destroy(); }
    },
    rejectAfterPair: (scenario, runs) => {
      if (options.completeAllPairs) return;
      if (scenario.input.minimumGain === undefined) return;
      const before = runs.find(run => run.role === 'baseline'), after = runs.find(run => run.role === 'candidate');
      if (before?.status !== 'complete' || after?.status !== 'complete') return;
      const direction = contract.acceptance.direction === 'maximize' ? 1 : -1;
      const gain = direction * (after.metrics![contract.acceptance.metric]! - before.metrics![contract.acceptance.metric]!);
      if (gain < scenario.input.minimumGain) return `Chess strategy did not improve required scenario ${scenario.id}`;
    },
    // These rules and the acceptance contract are host-owned, never read from executable output.
    measure: measureChessStrategyOutcome,
  }, signal);
  return enforceChessSampleRequirements(report, options.completeAllPairs === true);
}

/** Identical trusted outcome rules for single-path and complete-harness evaluation. */
export function measureChessStrategyOutcome(evidence: ChessStrategyEvaluationEvidence): Record<string, number> {
  const adapter = new ChessAdapter(evidence.player);
  return { value: adapter.value(evidence.after) - adapter.value(evidence.before),
    wins: Number(evidence.after.status === 'checkmate' && evidence.after.turn !== evidence.player),
    losses: Number(evidence.after.status === 'checkmate' && evidence.after.turn === evidence.player),
    draws: Number(evidence.after.status === 'draw'), plies: evidence.moves.length };
}

export function enforceChessSampleRequirements<Evidence extends ChessStrategyEvaluationEvidence>(report: EvaluationComparison<ChessStrategyScenario, Evidence>, checkIncident = true) {
  const contract = report.contract, groups = chessSampleGroups(contract);
  if (checkIncident) {
    const failed = contract.scenarios.find(scenario => scenario.input.minimumGain !== undefined
      && report.gains.some(pair => pair.scenarioId === scenario.id && pair.gain < scenario.input.minimumGain!));
    if (failed) { report.accepted = false; report.reason = `Chess strategy did not improve required scenario ${failed.id}`; }
  }
  if (groups.some(group => group.sample)) {
    const summary = summarizeChessComparison(report);
    for (const [index, group] of groups.entries()) {
      const result = summary.positions[index]!;
      if (group.sample && (result.completed !== result.planned || result.mean! < (group.sample.minimumMeanGain ?? -contract.acceptance.maximumCaseRegression)
        || result.improved < (group.sample.minimumImprovedPairs ?? 0))) {
        report.accepted = false; report.reason = 'Repeated comparisons did not demonstrate the required improvement at every position'; break;
      }
    }
  }
  return report;
}
