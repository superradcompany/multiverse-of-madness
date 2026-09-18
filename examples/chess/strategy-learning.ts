import { join, resolve } from 'node:path';
import { RevisionController, canonicalJson, type BudgetLedger, type EvaluationContract, type LearningRevision, type RevisionJournal, type RevisionPorts, type VersionRef } from '@multiverse/gameplay-harness';
import { JsonFileStore, contentRevision, type ExecutableStore } from '@multiverse/gameplay-harness/node';
import { chessLearningBinding, type ChessDecisionModel } from './revisions.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import { compareChessEvaluation } from './evaluation.ts';
import { parseChessPolicy } from './policy.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessEvaluationObserver } from './comparison-view.ts';

/** Durable source-revision controller. The application owns observation/scheduling and the session boundary.
 * Qualification currently covers preparation source only, not policy/search/model changes.
 */
export async function openChessStrategyLearning(options: {
  directory: string; baseline: LearningRevision<ChessPolicy>;
  /** Dynamic contracts are frozen by the host before generation, never supplied by candidate code. */
  contract: EvaluationContract<ChessStrategyScenario> | { version: VersionRef; resolve(proposalId: string): Promise<EvaluationContract<ChessStrategyScenario>> };
  store: ExecutableStore;
  context(): VersionRef;
  objective(): string;
  boundary: RevisionPorts<ChessPolicy>['boundary'];
  evaluationModel(artifact: LearningRevision<ChessPolicy>, ledger: BudgetLedger, runId: string): Promise<ChessDecisionModel>;
  liveModel(artifact: LearningRevision<ChessPolicy>): ChessDecisionModel;
  evaluationObserver?(proposalId: string): ChessEvaluationObserver;
}) {
  const directory = resolve(options.directory), baseline = structuredClone(options.baseline);
  const fixed = 'scenarios' in options.contract ? structuredClone(options.contract) : undefined;
  const dynamic = 'resolve' in options.contract ? options.contract : undefined;
  const rules = { contract: fixed ? contentRevision('chess-strategy-evaluation-contract', fixed) : structuredClone(dynamic!.version), capabilities: ['executor' as const], maxLifetimeMs: 3600000 };
  const journal = new JsonFileStore(join(directory, 'revisions.json'), value => value as RevisionJournal<ChessPolicy>);
  const save = (name: string, data: unknown) => new JsonFileStore(join(directory, name), value => value).save(data);
  const ports: RevisionPorts<ChessPolicy> = {
    context: options.context, boundary: options.boundary, persist: value => journal.save(value),
    verify: async artifact => {
      const { revision, ...fields } = artifact;
      if (!same(revision, contentRevision(revision.id, fields))) throw new Error('Chess strategy artifact digest mismatch');
      parseChessPolicy(artifact.policy);
      if (!same(artifact.adapter, baseline.adapter) || !same(artifact.model, baseline.model)) throw new Error('Chess strategy changes require the pinned adapter and decision model');
      await options.store.get(artifact.executor);
    },
    compatible: async (before, after) => {
      const { revision: _beforeRevision, executor: _beforeExecutor, ...beforeFields } = before;
      const { revision: _afterRevision, executor: _afterExecutor, ...afterFields } = after;
      if (!same(beforeFields, afterFields)) throw new Error('This chess evaluation qualifies preparation source changes only');
    },
    qualify: async (request, signal) => {
      if (!same(request.contract, rules.contract)) throw new Error('Chess evaluation contract mismatch');
      const contract = fixed ?? structuredClone(await dynamic!.resolve(request.proposalId));
      if (contract.scenarios.some(item => item.input.objective !== options.objective())) throw new Error('Chess evaluation contract does not match the current user objective');
      const prefix = `evaluations/${encodeURIComponent(request.proposalId)}`;
      const report = await compareChessEvaluation({ directory: join(directory, prefix, 'harness'), contract, baseline: request.baseline, candidate: request.candidate,
        observer: options.evaluationObserver?.(request.proposalId),
        model: (artifact, ledger, run) => options.evaluationModel(artifact, ledger, `${prefix}/${run}`), persistence: {
          persistBudget: (id, value) => save(`${prefix}/budgets/${encodeURIComponent(id)}.json`, value),
          persistRun: run => save(`${prefix}/runs/${encodeURIComponent(run.id)}.json`, run),
        },
      }, signal);
      await save(`${prefix}/comparison.json`, report);
      return { baseline: report.baseline, candidate: report.candidate, context: request.context, contract: request.contract,
        accepted: report.accepted, reason: report.reason, evidence: { comparison: contentRevision('chess-strategy-comparison', report), evaluatedContract: contentRevision('chess-strategy-evaluation-contract', contract) } };
    },
  };
  const saved = await journal.load();
  if (saved && !same(saved.initial, baseline.revision)) throw new Error('Chess learning baseline changed; explicit migration is required');
  const controller = saved ? await RevisionController.restore(saved, rules, ports) : await RevisionController.create(baseline, rules, ports);
  const identity = contentRevision('chess-strategy-journal', { directory, initial: baseline.revision, rules });
  return { controller, binding: chessLearningBinding(controller, identity, options.liveModel) };
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
