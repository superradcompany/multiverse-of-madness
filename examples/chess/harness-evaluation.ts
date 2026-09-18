import { join } from 'node:path';
import { canonicalJson, compareRevisions, type BudgetLedger, type EvaluationContract, type EvaluationPorts, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { ChessAdapter, ChessFixtureModel } from './adapter.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import { ChessWorld, type ChessSave, type ChessState } from './runtime.ts';
import { ChessSession } from './session.ts';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';
import type { ChessStrategyScenario, ChessStrategyEvaluationEvidence } from './strategy-evaluation.ts';
import { enforceChessSampleRequirements, measureChessStrategyOutcome } from './strategy-evaluation.ts';
import { chessSampleGroups } from './comparison-summary.ts';
import { parseChessPolicy } from './policy.ts';
import type { ChessEvaluationProgress } from './comparison-view.ts';

export interface ChessHarnessEvidence extends ChessStrategyEvaluationEvidence {
  harness: { attempts: ChessSessionCheckpoint['attempts']; selectedPlies: number; committed: ChessState; replayEndpoint: string; replayLastTick: number };
}
type Persistence = Pick<EvaluationPorts<ChessStrategyScenario, ChessHarnessEvidence>, 'persistBudget' | 'persistRun'>;

/** Full observe/decide/fork/trial/promote path, with the same fixed opponent in both roles.
 * The caller owns a unique directory and preparation resources; decisions, discarded inputs and preparation are metered.
 */
export async function compareChessHarnesses(options: {
  directory: string; contract: EvaluationContract<ChessStrategyScenario>;
  baseline: LearningRevision<ChessPolicy>; candidate: LearningRevision<ChessPolicy>;
  model(artifact: LearningRevision<ChessPolicy>, budget: BudgetLedger, runId: string): Promise<ChessDecisionModel>;
  persistence?: Persistence;
  progress?(value: ChessEvaluationProgress): Promise<void>;
}, signal: AbortSignal) {
  const { contract, baseline, candidate } = structuredClone({ contract: options.contract, baseline: options.baseline, candidate: options.candidate });
  return runComparison(options, contract, baseline, candidate, signal);
}

async function runComparison(options: Parameters<typeof compareChessHarnesses>[0], contract: EvaluationContract<ChessStrategyScenario>,
  baseline: LearningRevision<ChessPolicy>, candidate: LearningRevision<ChessPolicy>, signal: AbortSignal) {
  if (canonicalJson(baseline.adapter) !== canonicalJson(candidate.adapter)) throw new Error('Chess harness adapters differ');
  for (const artifact of [baseline, candidate]) parseChessPolicy(artifact.policy);
  chessSampleGroups(contract);
  for (const { id, input } of contract.scenarios) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(input.plies) || input.plies < 1 || !input.objective.trim()
      || canonicalJson(new ChessAdapter(input.player).version) !== canonicalJson(baseline.adapter)) throw new Error('Invalid chess harness scenario');
    if (input.minimumGain !== undefined && (!Number.isFinite(input.minimumGain) || input.minimumGain < 0)) throw new Error('Invalid chess scenario improvement gate');
    for (const artifact of [baseline, candidate]) {
      const worstInputs = artifact.policy.breadth * artifact.policy.trialPlies;
      const worstDecisions = 1 + artifact.policy.breadth * Math.max(0, artifact.policy.trialPlies - 1);
      if ((contract.budget.limits.simulation ?? 0) < Math.max(worstInputs, input.plies)
        || (contract.budget.limits.modelCalls ?? 0) < worstDecisions || (contract.budget.limits.executorCalls ?? 0) < worstDecisions) throw new Error('Chess harness comparison needs explicit exploration, decision and preparation allowances');
    }
  }
  const report = await compareRevisions<ChessStrategyScenario, ChessHarnessEvidence>(contract, baseline.revision, candidate.revision, {
    ...options.persistence,
    run: async (ref, scenario, budget, current) => {
      const role = canonicalJson(ref) === canonicalJson(baseline.revision) ? 'baseline' : 'candidate';
      const artifact = role === 'baseline' ? baseline : candidate, { input } = scenario;
      const runId = `${scenario.id}/${role}`, directory = join(options.directory, runId), adapter = new ChessAdapter(input.player);
      class HistoricalRuntime extends ChessRuntimeStore {
        constructor(private readonly history: ChessSave) { super(join(directory, 'runtime'), history.initialFen, {
          run: (id, apply) => budget.run({ owner: id, operation: 'harness-input', reserve: { simulation: 1 } }, async () => ({ value: await apply(), usage: { simulation: 1 } }), current),
        }); }
        override async create(id: string, creating: AbortSignal) { creating.throwIfAborted(); return this.createFrom(id, this.history); }
      }
      const runtime = new HistoricalRuntime(input.saved);
      const strategy = await options.model(artifact, budget, `${runId}/strategy`);
      const opponent = await options.model(baseline, budget, `${runId}/opponent`);
      // The outer session identifies the tested system; individual preparation/decision receipts retain the actual side's source revision.
      const model: ChessDecisionModel = { version: artifact.model,
        prepare: async (request, preparing) => {
          const own = request.state.turn === input.player, selected = own ? strategy : opponent, selectedRevision = own ? artifact.revision : baseline.revision;
          const sideRequest = { ...structuredClone(request), revision: selectedRevision };
          const prepared = selected.prepare ? await selected.prepare(sideRequest, preparing) : sideRequest;
          return { ...prepared, revision: request.revision };
        },
        decide: (request, deciding) => {
          const own = request.state.turn === input.player;
          return budget.run({ owner: runId, operation: 'harness-decision', reserve: { modelCalls: 1 } }, async () => ({
            value: await (own ? strategy : opponent).decide({ ...request, revision: own ? artifact.revision : baseline.revision }, deciding), usage: { modelCalls: 1 },
          }), current);
        },
      };
      const binding = { identity: contentRevision('chess-paired-harness', { contract, runId, candidate: artifact.revision, opponent: baseline.revision }),
        current: () => ({ activation: { epoch: 0, revision: artifact.revision }, artifact }), resolve: () => artifact, model: () => model };
      let session: ChessSession | undefined;
      const cancel = () => { void session?.pause().catch(() => {}); };
      current.addEventListener('abort', cancel, { once: true });
      try {
        current.throwIfAborted();
        session = await ChessSession.create(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), artifact.policy, binding);
        await session.guide(input.objective);
        const before = session.snapshot().worlds[0]!.state;
        const publish = async () => {
          const snapshot = session!.snapshot();
          await options.progress?.({ scenarioId: scenario.id, role, before, state: snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!.state,
            attemptedPlies: snapshot.attempts.plies, trials: snapshot.worlds.filter(world => snapshot.batch?.ids.includes(world.meta.id)).map(world => ({ label: world.label, state: world.state })) });
        };
        await publish();
        let after = before;
        while (after.status === 'ongoing' && after.ply - before.ply < input.plies) {
          current.throwIfAborted();
          const snapshot = session.snapshot();
          if (!snapshot.batch) {
            const maxInputs = after.turn === input.player ? artifact.policy.breadth * artifact.policy.trialPlies : 1;
            const maxCalls = after.turn === input.player ? 1 + artifact.policy.breadth * (artifact.policy.trialPlies - 1) : 1;
            // Stop at a clean boundary rather than begin a trial that cannot finish within the matched allowance.
            if (budget.remaining('simulation') < maxInputs || budget.remaining('modelCalls') < maxCalls || budget.remaining('executorCalls') < maxCalls) break;
          }
          await session.step();
          await publish();
          const next = session.snapshot(); after = next.worlds.find(world => world.meta.id === next.mainId)!.state;
        }
        current.throwIfAborted();
        const final = session.snapshot();
        if (final.batch || final.pendingFork || Object.keys(final.pendingInputs).length) throw new Error('Chess harness evaluation ended with unresolved execution');
        const replay = await session.replay(), moves: ChessStrategyEvaluationEvidence['moves'] = [], committed = after;
        // Finish the real trial, then score the same prefix in both roles. Extra lookahead stays metered and recorded.
        const scored = new ChessWorld('score-selected-prefix', { initialFen: after.initialFen, moves: after.moves.slice(0, before.ply + input.plies) });
        try { after = await scored.state(); } finally { await scored.destroy(); }
        const path = new ChessWorld('verify-selected-path', before);
        try { for (const selected of after.moves.slice(before.ply)) {
          const from = await path.state(), to = await path.step({ san: selected });
          moves.push({ before: from, after: to, selected, actor: from.turn === input.player ? 'strategy' : 'opponent' });
        } if (canonicalJson(await path.state()) !== canonicalJson(after)) throw new Error('Selected harness path differs from measured outcome'); }
        finally { await path.destroy(); }
        if (budget.used('simulation') !== final.attempts.plies || budget.used('modelCalls') !== final.attempts.decisions) throw new Error('Chess harness accounting differs from actual attempted work');
        return { ending: after.status === 'ongoing' ? 'budget' : 'terminal', evidence: { player: input.player, before, after, moves,
          harness: { attempts: final.attempts, selectedPlies: after.ply - before.ply, committed, replayEndpoint: final.mainId, replayLastTick: replay.lastTick } } };
      } finally { current.removeEventListener('abort', cancel); await session?.detach(); }
    },
    measure: measureChessStrategyOutcome,
  }, signal);
  enforceChessSampleRequirements(report);
  if (report.runs.some(run => run.evidence?.after.status === 'ongoing'
    && run.evidence.harness.selectedPlies < contract.scenarios.find(scenario => scenario.id === run.scenarioId)!.input.plies)) {
    report.accepted = false; report.reason = 'Full harness comparison did not reach the required selected-path horizon';
  }
  return report;
}
