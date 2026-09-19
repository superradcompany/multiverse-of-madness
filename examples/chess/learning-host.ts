import { chessAuditFeedback, chessEvaluationFeedback } from './evaluation-feedback.ts';
import { chessTrainingFeedback } from './training-feedback.ts';
import '../../scripts/runtime-env.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Image } from 'microsandbox';
import { BudgetLedger, canonicalJson, type AutonomousLearningState, type BudgetSnapshot, type LearningRevision, type RevisionPorts } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { CodexCliSupervisor } from '../../packages/supervisor-codex/src/provider.ts';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { ChessAdapter } from './adapter.ts';
import { ChessJevModel } from './jev.ts';
import { ChessPreparedModel } from './prepared-model.ts';
import { ChessAutomaticLearning, type ChessAutomaticMark } from './automatic-learning.ts';
import { decodeChessLearningJobs } from './learning-jobs.ts';
import { chessIncidentContractVersion } from './incident-contract.ts';
import { openChessStrategyLearning } from './strategy-learning.ts';
import { proposeChessStrategy, type ChessStrategyEvidence } from './strategy-proposal.ts';
import { chessLearningBaselinePolicy, defaultChessPolicy } from './policy.ts';
import { describeChess } from './description.ts';
import type { ChessRuntimeStore } from './runtime-store.ts';
import { chessSessionContext, type ChessSession } from './session.ts';
import type { ChessPolicy, ChessSessionCheckpoint } from './session-types.ts';
import { freezeChessReview, decodeFrozenChessReview } from './review-input.ts';
import { ChessRegressionAudits, type ChessRegressionJournal } from './regression-audits.ts';
import { compareChessEvaluation } from './evaluation.ts';
import { observeChessLearning } from './learning-observation.ts';
import { ChessComparisonViewer, type ChessComparisonView } from './comparison-view.ts';
import { chessHarnessEvaluator } from './evaluation-contract.ts';

/** Caller holds the session directory lease, stops gameplay before close, and attaches before start. */
export async function openChessLearningHost(directory: string, decision: ChessJevModel, runtime: ChessRuntimeStore) {
  const root = join(directory, 'learning'), adapter = new ChessAdapter(), store = new ExecutableStore(join(root, 'sources'));
  const viewer = await ChessComparisonViewer.open(new JsonFileStore(join(root, 'comparison-preview.json'), value => value as ChessComparisonView));
  const save = (name: string, value: unknown) => new JsonFileStore(join(root, name), input => input).save(value);
  const load = <T>(name: string) => new JsonFileStore(join(root, name), input => input as T).load();
  const imageStore = new JsonFileStore(join(root, 'image.json'), input => input as { image: string });
  let pinnedImage = await imageStore.load();
  if (!pinnedImage) { const image = await Image.get('docker.io/library/node:24-alpine'); if (!image.manifestDigest) throw new Error('Chess executor image is not pinned');
    pinnedImage = { image: `docker.io/library/node@${image.manifestDigest}` }; await imageStore.save(pinnedImage); }
  const pool = async (name: 'live' | 'evaluation') => {
    const records = await load<ExecutorRunRecord[]>(`${name}/executor-runs.json`) ?? [];
    const recordStore = new JsonFileStore<ExecutorRunRecord[]>(join(root, name, 'executor-runs.json'), input => input as ExecutorRunRecord[]);
    const executor = new MicrosandboxExecutor({ image: pinnedImage!.image, record: async record => {
      const index = records.findIndex(item => item.id === record.id); if (index < 0) records.push(record); else records[index] = record;
      await recordStore.save(records);
    } });
    const recover = async () => { for (const record of records.filter(item => item.phase !== 'released')) await executor.recover(record); };
    await recover(); return { executor, recover };
  };
  const live = await pool('live'), evaluation = await pool('evaluation');
  const ledger = async (name: string) => new BudgetLedger({ simulationUnit: 'chess-plies', limits: {} }, value => save(`${name}/usage.json`, value), await load<BudgetSnapshot>(`${name}/usage.json`));
  const liveLedger = await ledger('live'), supervisorLedger = await ledger('supervisor');
  const base = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `export default input => ({abi:'chess-preparation/1',guidance:'',plans:input.candidates.map(p=>({id:p.id,label:p.label,expectedBenefit:p.expectedBenefit})),experienceIndices:input.experience.map((_,i)=>i)});` } });
  const savedSession = await new JsonFileStore(join(directory, 'session.json'), input => input as ChessSessionCheckpoint).load();
  const baselinePolicy = chessLearningBaselinePolicy(savedSession);
  const fields = { executor: base.revision, adapter: adapter.version, model: contentRevision('chess-prepared-jev', { abi: 'chess-preparation/1', decision: decision.version }), policy: baselinePolicy, prompts: {}, skills: [] };
  const baseline: LearningRevision<ChessPolicy> = { ...fields, revision: contentRevision('chess-learning-system', fields) };
  const limits = { timeoutMs: 20000, cpus: 1, memoryMiB: 256, maxInputBytes: 65536, maxOutputBytes: 65536 };
  const startupContext = chessSessionContext(savedSession?.objective ?? 'win by checkmate', savedSession?.policy ?? defaultChessPolicy, adapter.version, savedSession?.games?.currentId);
  let session: ChessSession | undefined, automatic: ChessAutomaticLearning | undefined, audits: ChessRegressionAudits | undefined;
  let boundary: RevisionPorts<ChessPolicy>['boundary'] = work => requiredSession().revisionBoundary(work);
  const requiredSession = () => { if (!session) throw new Error('Attach the chess session first'); return session; };
  const learning = await openChessStrategyLearning({ directory: root, baseline, store,
    contract: { version: chessIncidentContractVersion, resolve: async id => {
      return decodeFrozenChessReview(await load(`reviews/${encodeURIComponent(id)}/input.json`), id).contract;
    } }, context: () => session?.supervisorContext() ?? startupContext, objective: () => requiredSession().snapshot().objective,
    boundary: work => boundary(work),
    evaluationObserver: id => viewer.observer(id, 'proposal'),
    trainingObserver: id => viewer.observer(id, 'training'),
    training: async request => {
      const review = decodeFrozenChessReview(await load(`reviews/${encodeURIComponent(request.proposalId)}/input.json`), request.proposalId);
      if (!review.training) return;
      const proposed = await load<Awaited<ReturnType<typeof proposeChessStrategy>>>(`reviews/${encodeURIComponent(request.proposalId)}/proposal.json`);
      if (!proposed || canonicalJson(proposed.artifact) !== canonicalJson(request.candidate)
        || canonicalJson(proposed.origin.activation.revision) !== canonicalJson(request.baseline.revision)
        || canonicalJson(proposed.origin.context) !== canonicalJson(request.context)) throw new Error('Chess training selection does not match the frozen proposal');
      return proposed.training ? { catalog: review.training, selection: proposed.training } : undefined;
    },
    liveModel: artifact => new ChessPreparedModel(artifact, { store, executor: live.executor, ledger: liveLedger, limits, decision,
      record: value => save(`live/preparations/${randomUUID()}.json`, value) }),
    evaluationModel: async (artifact, budget, runId) => new ChessPreparedModel(artifact, { store, executor: evaluation.executor, ledger: budget, limits,
      decision: await ChessJevModel.open(join(root, runId, 'jev')), record: value => save(`${runId}/preparations/${randomUUID()}.json`, value) }),
  });
  return {
    binding: learning.binding,
    async attach(value: ChessSession, ready: () => boolean, sessionBoundary?: RevisionPorts<ChessPolicy>['boundary']) {
      if (session) throw new Error('Chess learning session is already attached'); session = value;
      if (sessionBoundary) boundary = sessionBoundary;
      audits = await ChessRegressionAudits.open({ binding: learning.binding.identity, controller: learning.controller,
        store: new JsonFileStore(join(root, 'audits.json'), input => input as ChessRegressionJournal),
        context: () => requiredSession().supervisorContext(), ready, recover: evaluation.recover,
        read: id => load(`audits/${id}/comparison.json`), write: (id, report) => save(`audits/${id}/comparison.json`, report),
        evaluate: (audit, before, after, signal) => compareChessEvaluation({ directory: join(root, 'audits', audit.id, 'harness'), contract: audit.review.contract, baseline: before, candidate: after, completeAllPairs: true,
          observer: viewer.observer(audit.id, 'audit'),
          model: async (artifact, budget, runId) => new ChessPreparedModel(artifact, { store, executor: evaluation.executor, ledger: budget, limits,
            decision: await ChessJevModel.open(join(root, 'audits', audit.id, runId, 'jev')),
            record: receipt => save(`audits/${audit.id}/${runId}/preparations/${randomUUID()}.json`, receipt) }),
          persistence: { persistBudget: (id, budget) => save(`audits/${audit.id}/budgets/${encodeURIComponent(id)}.json`, budget),
            persistRun: run => save(`audits/${audit.id}/runs/${encodeURIComponent(run.id)}.json`, run) },
        }, signal),
      });
      {
        const receipts = [
          ...learning.controller.snapshot().proposals.flatMap(proposal => {
            const hash = (proposal.qualification?.evidence as { comparison?: { id: string; version: string } } | undefined)?.comparison;
            return hash ? [{ id: proposal.id, kind: 'proposal' as const, createdAt: proposal.createdAt, path: `evaluations/${encodeURIComponent(proposal.id)}/comparison.json`, hash }] : [];
          }),
          ...audits.snapshot().audits.flatMap(audit => audit.comparison ? [{ id: audit.id, kind: 'audit' as const, createdAt: audit.createdAt, path: `audits/${audit.id}/comparison.json`, hash: audit.comparison }] : []),
        ].sort((a, b) => b.createdAt - a.createdAt);
        const latest = receipts[0];
        const cached = viewer.snapshot();
        if (latest && (!cached || (cached.id === latest.id && cached.kind === latest.kind))) {
          const report = await load<Parameters<ChessComparisonViewer['restoreReport']>[2]>(latest.path);
          if (report && canonicalJson(contentRevision('chess-strategy-comparison', report)) === canonicalJson(latest.hash)) await viewer.restoreReport(latest.id, latest.kind, report);
        }
      }
      automatic = await ChessAutomaticLearning.open({ binding: learning.binding.identity, controller: learning.controller,
        state: new JsonFileStore(join(root, 'automatic.json'), input => input as AutonomousLearningState<ChessAutomaticMark>),
        jobs: new JsonFileStore(join(root, 'jobs.json'), decodeChessLearningJobs),
        snapshot: () => requiredSession().snapshot(), context: () => requiredSession().supervisorContext(), ready,
        recover: evaluation.recover, settled: evaluation.recover, bootstrap: true,
        beforeReview: async state => {
          if (audits!.busy || audits!.snapshot().audits.some(audit => audit.status === 'pending')) return audits!.tick();
          if (!ready()) return false;
          const journal = learning.controller.snapshot(), activation = journal.history.at(-1);
          if (!activation || activation.kind !== 'activate' || audits!.hasCurrentCheck()) return false;
          const original = activation.proposalId ? await load<{ contract: { evaluator: { id: string; version: string } } }>(`reviews/${activation.proposalId}/input.json`) : undefined;
          // One recheck when frozen evaluator semantics change; ordinary audits still require fresh adverse gameplay.
          const legacy = Boolean(original && canonicalJson(original.contract.evaluator) !== canonicalJson(chessHarnessEvaluator(learning.controller.current.policy)));
          const evidence = observeChessLearning(requiredSession().snapshot(), legacy ? undefined : state.lastObservation?.evidence.mark,
            { bootstrap: legacy, revision: journal.active.revision });
          if (legacy && evidence) evidence.reason = 'Recheck the active strategy using the current gameplay comparison rules; its original qualification used an older evaluator.';
          return evidence ? audits!.tick({ evidence, origin: { activation: journal.active, context: requiredSession().supervisorContext() } }) : false;
        },
        propose: async (id, mark, signal) => {
          const prefix = `reviews/${encodeURIComponent(id)}`;
          const auditFeedback = await chessAuditFeedback(audits!.snapshot(), id => load(`audits/${id}/comparison.json`));
          const proposalFeedback = await chessEvaluationFeedback(learning.controller.snapshot(), proposalId => load(`evaluations/${encodeURIComponent(proposalId)}/comparison.json`));
          const recentEvaluations = [...auditFeedback.slice(0, 1), ...proposalFeedback].slice(0, 2);
          const recentTraining = await chessTrainingFeedback(learning.controller.snapshot(), proposalId => load(`evaluations/${encodeURIComponent(proposalId)}/training/report.json`));
          const current = learning.controller.current;
          const review = freezeChessReview(id, mark, recentEvaluations, current.policy, recentTraining);
          await save(`${prefix}/input.json`, review);
          const provider = await CodexCliSupervisor.open<ChessPolicy, ChessStrategyEvidence>({ record: value => save(`${prefix}/generation.json`, value) });
          const proposed = await proposeChessStrategy({ id, origin: mark.origin, current, objective: mark.evidence.mark.objective,
            game: describeChess(adapter.version, runtime.capabilities), contract: chessIncidentContractVersion,
            observations: mark.evidence.observations, temporaryGoal: mark.evidence.temporaryGoal, recentEvaluations, review: { reason: mark.evidence.reason, issue: mark.evidence.mark.issue },
            training: review.training, recentTraining: review.recentTraining,
            provider, store, ledger: supervisorLedger, limits: { timeoutMs: 300000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 2000000 },
          }, signal);
          await save(`${prefix}/proposal.json`, proposed); signal.throwIfAborted();
          await learning.controller.submit({ id, candidate: proposed.artifact, reason: proposed.reason, expected: mark.origin, expiresAt: Date.now() + 3600000 });
        },
      });
      automatic.start();
    },
    view() {
      const status = automatic?.snapshot(), journal = learning.controller.snapshot();
      const proposal = status?.cycle ? journal.proposals.find(item => item.id === status.cycle!.proposalId) : undefined;
      const previous = status?.lastOutcome ? journal.proposals.find(item => item.id === status.lastOutcome!.proposalId) : undefined;
      const activeJob = status?.jobs.find(item => ['queued', 'running', 'cancelling'].includes(item.status));
      const audit = audits?.snapshot().audits.at(-1);
      return { enabled: status?.enabled ?? false, revision: journal.active.epoch,
        stage: !status?.enabled ? 'off' : audits?.busy || audit?.status === 'pending' ? 'testing' : status.busy ? (proposal ? 'testing' : 'reviewing') : proposal?.status === 'qualified' ? 'ready' : 'watching',
        reason: status?.cycle?.reason ?? status?.lastOutcome?.reason,
        elapsedSeconds: audits?.busy && audit ? Math.max(0, Math.floor((Date.now() - audit.createdAt) / 1000)) : activeJob ? Math.max(0, Math.floor((Date.now() - activeJob.createdAt) / 1000)) : undefined,
        lastOutcome: status?.lastOutcome ? { ...status.lastOutcome,
          active: previous !== undefined && canonicalJson(previous.candidate) === canonicalJson(journal.active.revision),
          reason: previous?.qualification?.reason ?? status.lastOutcome.reason } : undefined, error: status?.ownerError ?? status?.error,
        audit: audit ? { status: audit.status, reason: audit.reason, summary: audit.summary } : undefined,
        comparison: viewer.summary(),
      };
    },
    comparison() { return viewer.snapshot(); },
    async setEnabled(enabled: boolean) { if (!automatic) throw new Error('Chess learning is not attached'); await automatic.setEnabled(enabled); if (!enabled) await audits?.cancel(); },
    async close() {
      try { try { await automatic?.close(); } finally { await audits?.close(); } await learning.controller.join(); }
      finally { await evaluation.recover(); await live.recover(); await liveLedger.join(); await supervisorLedger.join(); await viewer.close(); }
    },
  };
}
export type ChessLearningHost = Awaited<ReturnType<typeof openChessLearningHost>>;
