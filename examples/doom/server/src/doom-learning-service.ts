import { doomTrainingCatalog } from './doom-curriculum.ts';
import { trainingMenu, validateTrainingSelection } from '@multiverse/gameplay-harness';
import { DoomLearningIncidents, decodeDoomIncidents } from './doom-learning-incidents.ts';
import { activeSkills } from '../../contracts/src/skills.ts';
import { decodeDoomLearningManifest as decodeManifest, type DoomLearningManifest as Manifest } from './doom-learning-manifest.ts';
import { DoomEvaluationProcess } from './doom-evaluation-process.ts';
import { doomLearningDirectory, readDoomLearningHistory } from './doom-learning-lineage.ts';
import { doomAutonomousState, DoomGoalReview, doomActivationObservation, observeDoomLearning, doomAutomaticProposalKind, type DoomLearningMark } from './doom-autonomous-learning.ts';
import { summarizeSupervisorTokens, supervisorTokens, type SupervisorTokens } from './supervisor-token-usage.ts';
import { LearningEvaluationReader } from './learning-evaluation-view.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { AutonomousLearning, BudgetLedger, canonicalJson, type BudgetSnapshot, type BudgetSpec, type EvaluationContract, type ExecutorLimits, type LearningRevision,
  type SupervisorLimits, type SupervisorProvider, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../../../packages/executor-microsandbox/src/executor.ts';
import { CodexCliSupervisor } from '../../../../packages/supervisor-codex/src/provider.ts';
import { ClaudeCodeSupervisor, SupervisorFailure } from '../../../../packages/supervisor-claude/src/provider.ts';
import type { BackgroundLearningView, LearningProposalDetail, LearningView, SupervisorCli } from '../../contracts/src/learning.ts';
import type { VmResources } from '../../contracts/src/vm.ts';
import { DoomSupervisor, decodeDoomSupervisor } from './doom-supervisor.ts';
import { DoomLearningJobs, decodeDoomLearningJobs, type DoomLearningCommand } from './doom-learning-jobs.ts';
import { decodeDoomProposal, doomPreviousExperiments, type DoomProposalEvidence, type DoomProposalRecord } from './doom-supervisor-proposal.ts';
import { DoomLearningModels, doomLearningArtifact } from './doom-learning-models.ts';
import { DoomExecutableModel } from './doom-executor-model.ts';
import { DoomPreparedModel } from './doom-prepared-model.ts';
import { DoomVmEvaluations, type DoomVmScenario } from './doom-vm-evaluations.ts';
import { microsandboxEvaluationVmPorts } from './doom-evaluation-vm-provider.ts';
import { doomSurvivalProgress } from './doom-revision-evaluation.ts';
import { retainDoomLearningBuild, type DoomLearningBuild } from './doom-learning-build.ts';
import type { DoomPolicy } from './doom-policy.ts';
import type { JevProfile } from './jev.ts';
import { sessionContinuation, type Session } from './session.ts';
import type { DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';

const generationBudget = { simulationUnit: 'doom-ticks', limits: { supervisorCalls: 10, costMicros: 5000000 } };
const liveBudget = { simulationUnit: 'doom-ticks', limits: { modelCalls: 10000, executorCalls: 1000 } };
const proposalLimits: SupervisorLimits = { timeoutMs: 120000, maxInputBytes: 131072, maxOutputBytes: 65536, maxCostMicros: 500000 };
const executorLimits: ExecutorLimits = { timeoutMs: 10000, cpus: 1, memoryMiB: 256, maxInputBytes: 1048576, maxOutputBytes: 16384 };
const resources: VmResources = { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 };
export interface DoomLearningServiceOptions {
  backgroundLearning?: boolean;
  bootstrapPlanner?: boolean;
  directory: string; profile: JevProfile; build: DoomLearningBuild;
  /** Trusted host overrides; none is accepted from browser commands or proposed artifacts. */
  image?: string;
  modelClient?: Pick<TypeSafeClient, 'systemOne'>;
  runtime?: DoomEvaluationVmPorts;
  proposalProvider?(record: (value: unknown) => Promise<void>, provider: SupervisorCli): Promise<SupervisorProvider<DoomPolicy, DoomProposalEvidence>>;
}
/** Production composition; the caller owns the data lease and serializes enable/activation with game commands. */
export class DoomLearningService {
  private manifest?: Manifest;
  private session?: Session;
  private supervisor?: DoomSupervisor;
  private jobs?: DoomLearningJobs;
  private historicalExperiments: Record<string, unknown>[] = [];
  private incidents?: DoomLearningIncidents;
  private evaluator?: DoomVmEvaluations | DoomEvaluationProcess;
  private generation?: BudgetLedger;
  private legacyGeneration?: BudgetLedger;
  private live?: BudgetLedger;
  private legacyLive?: BudgetLedger;
  private models?: DoomLearningModels;
  private executor?: MicrosandboxExecutor;
  private readonly executionRecords = new Map<string, ExecutorRunRecord>();
  private readonly stores = new Map<string, JsonFileStore<any>>();
  private closing?: Promise<void>;
  private enabled = false;
  private automation?: AutonomousLearning<DoomLearningMark>;
  private automationTimer?: ReturnType<typeof setInterval>;
  private automationError?: string;
  private automaticProvider: SupervisorCli = 'codex';
  private readonly providerTokens = new Map<string, SupervisorTokens>();
  private readonly previews: LearningEvaluationReader;
  private constructor(private readonly options: DoomLearningServiceOptions) {
    this.previews = new LearningEvaluationReader(join(options.directory, 'evaluations'));
  }

  static async open(options: DoomLearningService['options'], expectedBinding?: VersionRef): Promise<DoomLearningService> {
    const directory = await doomLearningDirectory(options.directory, expectedBinding);
    const owner = new DoomLearningService({ ...options, directory, build: structuredClone(options.build) });
    const saved = await owner.store('manifest.json', decodeManifest).load();
    if (!saved && expectedBinding) throw new Error('The supervised game is missing its learning service manifest');
    if (saved) { owner.manifest = saved; await owner.configure(expectedBinding); }
    return owner;
  }
  get binding() { return this.supervisor?.binding; }

  /** Restore learning, or initialize it automatically at a safe gameplay boundary. */
  async attach(session: Session): Promise<void> {
    if (this.session && this.session !== session) throw new Error('Learning service already has a game');
    this.session = session;
    if (session.checkpoint().learning) {
      if (!this.supervisor) throw new Error('Missing learning supervisor');
      this.supervisor.attach(session); this.enabled = true; await this.openJobs();
    } else if (this.options.backgroundLearning !== false && this.options.profile === 'game-aware') {
      if (this.view().canEnable) await this.enable();
      else session.queueLearningActivation('initialize-background-learning', () => this.enable());
    }
  }
  async enable(): Promise<void> {
    const session = this.game();
    if (this.enabled) return;
    if (this.options.profile !== 'game-aware') throw new Error('This Doom learning evaluator requires the game-aware profile');
    await session.revisionBoundary(async () => {});
    if (!this.manifest) {
      await retainDoomLearningBuild(join(this.options.directory, 'build'), this.options.build);
      let image = this.options.image;
      if (!image) {
        const { Image } = await import('microsandbox'); const current = await Image.get('docker.io/library/node:24-alpine');
        if (!current.manifestDigest) throw new Error('Learning requires a pinned runtime image');
        image = `docker.io/library/node@${current.manifestDigest}`;
      }
      const initial = doomLearningArtifact({ policy: session.learningPolicy(), prompts: {}, skills: [],
        adapter: this.adapter(), executor: this.builtin(), model: { id: 'typesafe', version: process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest' } });
      const contract = { id: 'doom-private-survival-progress-v1', evaluator: this.options.build.revision, allowance: 'complete-futures-v1' as const,
        scenarios: [
          [{ ticks: 7, inputs: ['left'] }, { ticks: 21, inputs: ['forward'] }],
          [{ ticks: 21, inputs: ['right'] }, { ticks: 28, inputs: ['forward'] }],
          [{ ticks: 35, inputs: ['forward'] }, { ticks: 35, inputs: ['left'] }],
        ].map((setup, index) => ({ id: 'start-' + index, seed: 'doom-initial-rng', input: { setup, minimumSelectedTicks: 210 } })) as EvaluationContract<DoomVmScenario>['scenarios'],
        budget: { simulationUnit: 'doom-ticks', limits: { simulation: 4200, modelCalls: 64, executorCalls: 64 } }, maxRunMs: 180000,
        acceptance: { metric: 'score', direction: 'maximize' as const, minimumMeanGain: 1, maximumCaseRegression: 0 } };
      const fields = { version: 1 as const, build: this.options.build, profile: 'game-aware' as const, image,
        resources, initial, contract, generationBudget, liveBudget, proposalLimits, executorLimits };
      this.manifest = { ...structuredClone(fields), revision: contentRevision('doom-learning-service', fields) };
      await this.store('manifest.json', decodeManifest).save(this.manifest);
      await this.configure();
    }
    await this.supervisor!.adopt(session); this.enabled = true; await this.openJobs();
  }

  async start(command: DoomLearningCommand) {
    this.ready();
    // Keep repeated historical IDs unchanged; newly admitted jobs pin the selected CLI.
    const previous = this.jobs!.snapshot().jobs.find(job => job.command.id === command.id);
    if (command.kind === 'propose' && command.provider === undefined) {
      const provider = previous?.command.kind === 'propose' ? previous.command.provider : 'codex';
      return this.jobs!.start({ ...command, ...(provider ? { provider } : {}) });
    }
    return this.jobs!.start(command);
  }
  async cancel(id: string) { this.ready(); return this.jobs!.cancel(id); }
  async activate(id: string) {
    this.ready(); if (this.jobs!.busy) throw new Error('Wait for the learning job to finish cleanup');
    await this.supervisor!.activate(id);
  }
  async rollback(target: VersionRef) {
    this.ready(); if (this.jobs!.busy) throw new Error('Wait for the learning job to finish cleanup');
    await this.supervisor!.rollback(target, 'Rolled back from the learning review panel');
  }
  async detail(id: string): Promise<LearningProposalDetail> {
    this.ready(); z.string().uuid().parse(id);
    const journal = this.supervisor!.overview().journal, proposal = journal.proposals.find(item => item.id === id);
    if (!proposal) throw new Error('Unknown learning proposal');
    const sources: LearningProposalDetail['sources'] = [], store = new ExecutableStore(join(this.options.directory, 'executables'));
    for (const [role, reference] of [['baseline', proposal.basedOn.revision], ['candidate', proposal.candidate]] as const) {
      const artifact = journal.artifacts.find(item => same(item.revision, reference))!;
      if (artifact.executor.id === 'learning-executor') { const { source } = await store.get(artifact.executor); sources.push({ role, entrypoint: source.entrypoint, files: source.files }); }
    }
    const record = await this.proposalStore(id).load();
    const providerRecord = await this.store('provider/' + id + '.json', value => value as { tokenUsage?: { inputTokens: number; outputTokens: number } }).load();
    return { sources, provider: record?.receipt?.provider.id === 'codex-cli-supervisor' ? 'codex' : 'claude',
      servingModels: record?.receipt?.servingModels, usage: record?.receipt?.usage ?? providerRecord?.tokenUsage };
  }

  async setAutomation(enabled: boolean, provider: SupervisorCli) {
    this.ready();
    await this.store('automation-preferences.json', value => z.strictObject({ provider: z.enum(['codex', 'claude']) }).parse(value)).save({ provider });
    this.automaticProvider = provider;
    if (!this.automation) throw new Error('Background learning is not configured');
    await this.automation.setEnabled(enabled); this.automationError = undefined;
  }

  async evaluationView(id: string) {
    this.ready(); z.string().uuid().parse(id);
    if (!this.supervisor!.overview().journal.proposals.some(proposal => proposal.id === id)) throw new Error('Unknown learning proposal');
    const job = this.jobs!.snapshot().jobs.find(job => job.command.kind === 'evaluate' && job.command.proposalId === id);
    return this.previews.view(id, Boolean(job && ['queued', 'running', 'cancelling'].includes(job.status)));
  }
  evaluationFrame(digest: string) { return this.previews.frame(digest); }
  async evaluationReplayFrames(id: string, runId: string, start: number, count: number) {
    this.ready(); z.string().uuid().parse(id);
    if (!this.supervisor!.overview().journal.proposals.some(proposal => proposal.id === id)) throw new Error('Unknown learning proposal');
    return this.previews.replayFrames(id, runId, start, count);
  }

  backgroundView(): BackgroundLearningView {
    const state = this.automation?.snapshot();
    const activeJob = this.jobs?.snapshot().jobs.find(job => ['queued', 'running', 'cancelling'].includes(job.status));
    const stage = !this.enabled ? this.options.profile === 'game-aware' && this.options.backgroundLearning !== false ? 'waiting' : 'unavailable'
      : !state?.enabled ? 'paused' : activeJob?.command.kind === 'propose' ? this.incidents?.isCapturing(activeJob.command.id) ? 'waiting' : 'reviewing'
      : activeJob?.command.kind === 'evaluate' ? 'testing' : state.cycle ? 'applying' : 'watching';
    const current = this.supervisor?.binding.current();
    const applied = current ? this.supervisor!.overview().journal.proposals.find(proposal => same(proposal.candidate, current.artifact.revision) && proposal.status === 'activated') : undefined;
    const strategy = current ? { activation: current.activation, planner: current.artifact.model.id === 'prepared-doom-jev',
      guidance: Object.entries(current.artifact.prompts).filter(([, text]) => text.trim()).map(([slot, text]) => ({ slot, text })),
      skills: current.artifact.skills, reason: applied?.reason,
      previousGuidance: applied ? Object.entries(this.supervisor!.overview().journal.artifacts.find(artifact => same(artifact.revision, applied.basedOn.revision))!.prompts).filter(([, text]) => text.trim()).map(([slot, text]) => ({ slot, text })) : undefined } : undefined;
    return { strategy, ready: Boolean(this.automation), enabled: state?.enabled ?? false, provider: this.automaticProvider, stage,
      error: this.automationError ?? state?.error, proposalId: state?.cycle?.proposalId ?? state?.lastOutcome?.proposalId, reason: state?.cycle?.reason,
      result: state?.lastOutcome ? { status: state.lastOutcome.status, reason: state.lastOutcome.reason } : undefined };
  }

  view(): LearningView {
    const game = this.game(), view = game.snapshot(), journal = this.supervisor?.overview().journal;
    const reason = view.running || view.busy ? 'Pause the session first.' : view.manualChoiceRequired || view.worlds.some(world => world.role === 'experiment') ? 'Resolve the current futures first.'
      : view.worlds.some(world => world.controller === 'human') ? 'Return control to AI first.'
      : view.worlds.find(world => world.id === view.mainId)?.plan?.status === 'running' ? 'Finish the current plan first.' : undefined;
    const context = game.supervisorContext(), busy = this.jobs?.busy ?? false;
    const evaluation = this.manifest?.contract;
    const generationUsage = this.generation?.snapshot();
    const ledgers = [this.legacyGeneration?.snapshot(), generationUsage].filter((value): value is BudgetSnapshot => value !== undefined);
    return { automation: this.automation ? { ...this.automation.snapshot(), provider: this.automaticProvider, error: this.automationError ?? this.automation.snapshot().error } : undefined, defaultProvider: this.automaticProvider, providers: ['codex', 'claude'], enabled: this.enabled, busy, canEnable: !this.enabled && !reason && this.options.profile === 'game-aware', boundaryReason: reason,
      active: this.enabled ? journal?.active : undefined, history: journal?.history ?? [],
      jobs: (this.jobs?.snapshot().jobs ?? []).slice(-30).reverse().map(job => ({ id: job.command.id, kind: job.command.kind,
        preparingCheckpoint: this.incidents?.isCapturing(job.command.id) || undefined,
        provider: job.command.kind === 'propose' ? job.command.provider ?? 'claude' : undefined,
        proposalId: job.command.kind === 'evaluate' ? job.command.proposalId : undefined, status: job.status, outcome: job.outcome, error: job.error, createdAt: job.createdAt })),
      proposals: (journal?.proposals ?? []).slice(-30).reverse().map(proposal => {
        const before = journal!.artifacts.find(artifact => same(artifact.revision, proposal.basedOn.revision))!;
        const after = journal!.artifacts.find(artifact => same(artifact.revision, proposal.candidate))!;
        const stale = !same(proposal.context, context) || !same(proposal.basedOn, journal!.active) || proposal.expiresAt <= Date.now();
        const evidence = proposal.qualification?.evidence as { meanGain?: number; gains?: Array<{ gain: number }> } | undefined;
        return { id: proposal.id, status: proposal.status, reason: proposal.reason, changed: proposal.capabilities, createdAt: proposal.createdAt, revision: proposal.candidate, stale,
          canEvaluate: !busy && !stale && proposal.status === 'proposed', canActivate: !busy && !reason && !stale && proposal.status === 'qualified',
          changes: (['policy', 'prompts', 'skills', 'executor', 'model'] as const).filter(field => !same(before[field], after[field])).map(field => ({ field, before: before[field], after: after[field] })),
          result: proposal.qualification ? { accepted: proposal.qualification.accepted, reason: proposal.qualification.reason, meanGain: evidence?.meanGain,
            cases: evidence?.gains?.length ?? 0, regressedCases: evidence?.gains?.filter(item => item.gain < 0).length ?? 0 } : undefined, error: proposal.error };
      }),
      budget: { ...summarizeSupervisorTokens(ledgers, this.providerTokens), proposalCalls: (this.legacyGeneration?.used('supervisorCalls') ?? 0) + (this.generation?.used('supervisorCalls') ?? 0), proposalCallLimit: null,
        costMicros: (this.legacyGeneration?.used('costMicros') ?? 0) + (this.generation?.used('costMicros') ?? 0), costLimitMicros: null, perProposalCostMicros: null,
        unknownCostCalls: generationUsage?.entries.filter(entry => entry.usage?.costMicros === undefined).length ?? 0,
        liveModelCalls: (this.legacyLive?.used('modelCalls') ?? 0) + (this.live?.used('modelCalls') ?? 0), liveModelCallLimit: null,
        liveExecutorCalls: (this.legacyLive?.used('executorCalls') ?? 0) + (this.live?.used('executorCalls') ?? 0), liveExecutorCallLimit: null },
      evaluation: { cases: evaluation?.scenarios.length ?? 3, ticksPerRun: evaluation?.budget.limits.simulation ?? 4200,
        modelCallsPerRun: evaluation?.budget.limits.modelCalls ?? 64, executorCallsPerRun: evaluation?.budget.limits.executorCalls ?? 64,
        minimumSelectedTicks: evaluation ? Math.min(...evaluation.scenarios.map(scenario => scenario.input.minimumSelectedTicks ?? 0)) : 210,
        maxRunSeconds: (evaluation?.maxRunMs ?? 180000) / 1000 } };
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown() {
    clearInterval(this.automationTimer);
    try { await this.automation?.close(); } finally {
      try { await this.jobs?.close(); } finally {
        try {
          await this.evaluator?.recover();
          if (this.evaluator instanceof DoomEvaluationProcess) await this.evaluator.close();
          for (const record of this.executionRecords.values()) if (record.phase !== 'released') await this.executor!.recover(record);
          await this.live?.join(); await this.generation?.join();
          await this.collectIncidents();
        } finally { await this.supervisor?.close(); }
      }
    }
  }
  private async configure(expectedBinding?: VersionRef) {
    const manifest = this.manifest!;
    if (manifest.profile !== this.options.profile || !same(manifest.build, this.options.build)) throw new Error('The supervised game requires its original gameplay build. Restore the retained build before reopening; no revision was substituted.');
    const budget = async (name: string, spec: BudgetSpec) => {
      const store = this.store(name, value => value as BudgetSnapshot);
      const ledger = new BudgetLedger(spec, value => store.save(value), await store.load()); await store.save(ledger.snapshot()); return ledger;
    };
    const legacy = await this.store('proposal-budget.json', value => value as BudgetSnapshot).load();
    if (legacy) this.legacyGeneration = new BudgetLedger(manifest.generationBudget, undefined, legacy);
    this.generation = await budget('supervisor-usage.json', { simulationUnit: 'doom-ticks', limits: {} });
    // Preserve historical accounting and its original contract unchanged. New live
    // play is metered without a lifetime cap, independently of evaluation budgets.
    const oldLive = await this.store('live-budget.json', value => value as BudgetSnapshot).load();
    if (oldLive) this.legacyLive = new BudgetLedger(manifest.liveBudget, undefined, oldLive);
    this.live = await budget('live-usage.json', { simulationUnit: 'doom-ticks', limits: {} });
    const records = this.store('executor-runs.json', value => {
      if (!Array.isArray(value)) throw new Error('Invalid executor journal'); return value as ExecutorRunRecord[];
    });
    for (const record of await records.load() ?? []) this.executionRecords.set(record.id, record);
    this.executor = new MicrosandboxExecutor({ image: manifest.image, record: async record => { this.executionRecords.set(record.id, structuredClone(record)); await records.save([...this.executionRecords.values()]); } });
    for (const record of this.executionRecords.values()) if (record.phase !== 'released') await this.executor.recover(record);
    this.models = this.registry(this.live, true);
    const context = () => {
        const saved = this.game().checkpoint(); return { revision: this.game().supervisorContext(), value: {
          maximumFutures: saved.view.maxFutures, objective: saved.view.pendingObjective ?? saved.view.objective, skills: saved.view.skills ?? [], overrides: saved.learning?.overrides ?? {} } };
      };
    // Fixture adapters stay in-process. Real background games own a separate
    // event loop and executor journal so they cannot stall live frame delivery.
    this.evaluator = this.options.runtime || this.options.modelClient
      ? new DoomVmEvaluations({ directory: join(this.options.directory, 'evaluations'), contract: manifest.contract,
        runtime: this.options.runtime ?? microsandboxEvaluationVmPorts(manifest), models: ledger => this.registry(ledger), measure: doomSurvivalProgress, context })
      : new DoomEvaluationProcess(this.options.directory, manifest, context);
    await this.evaluator.recover();
    this.incidents = await DoomLearningIncidents.open({ store: this.store('incidents.json', decodeDoomIncidents),
      capture: (reference, signal) => this.game().captureLearningIncident(reference, signal),
      runtime: this.options.runtime ?? microsandboxEvaluationVmPorts(manifest) });
    const historical = manifest.history ? await readDoomLearningHistory(this.options.directory, manifest.history, history => {
      this.historicalExperiments = history.lineages.flatMap(lineage => doomPreviousExperiments(lineage.journal, lineage.identity))
        .slice(-4).map(value => ({ ...value, historicalBuild: true, sameUserContext: false }));
    }) : undefined;
    this.supervisor = await DoomSupervisor.open({ historical, models: this.models, store: this.store('supervisor.json', decodeDoomSupervisor), expectedBinding,
      initial: manifest.initial, rules: { contract: this.evaluator.version, capabilities: ['policy', 'prompts', 'skills', 'executor', 'model'], maxLifetimeMs: 24 * 3600000 },
      qualify: async (request, signal) => {
        const retained = this.incidents!.snapshot().records.some(record => record.proposalId === request.proposalId);
        const incident = retained ? this.incidents!.ready(request.proposalId) : undefined;
        const record = await this.proposalStore(request.proposalId).load();
        const catalog = doomTrainingCatalog(manifest.contract);
        const training = record?.training;
        if (training) {
          if (!same(record.candidate, request.candidate) || !same(record.request.origin.context, request.context)
            || !same(record.request.current, request.baseline) || !same(record.request.evidence.training, trainingMenu(catalog))) throw new Error('Doom practice proposal no longer matches this qualification');
          validateTrainingSelection(catalog, training);
        }
        return this.evaluator!.qualify(request, signal, incident?.snapshot, incident ? sessionContinuation(incident.evidence) : undefined, training);
      } });
    await this.collectIncidents();
  }
  private registry(ledger: BudgetLedger, live = false): DoomLearningModels {
    const manifest = this.manifest!, executables = new ExecutableStore(join(this.options.directory, 'executables'));
    return new DoomLearningModels({ adapter: this.adapter(), builtinExecutor: this.builtin(), profile: manifest.profile, executables, client: this.options.modelClient,
      executable: artifact => {
        const options = { ledger, store: executables, executor: this.executor!, limits: manifest.executorLimits,
          record: (value: unknown) => this.store('executor-decisions/' + randomUUID() + '.json', input => input).save(value) };
        return artifact.model.id === 'prepared-doom-jev' ? new DoomPreparedModel(artifact, { ...options, client: this.options.modelClient }) : new DoomExecutableModel(artifact, options);
      },
      wrap: live ? (artifact, model) => artifact.model.id !== 'typesafe' ? model : { decide: (...args) => ledger.run({ owner: artifact.revision.version,
        operation: 'live-jev', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
          const value = await model.decide(...args); if (!value.usage) throw new Error('Jev did not report usage');
          return { value, usage: { modelCalls: 1, ...value.usage } };
        }, args[3]) } : undefined });
  }
  private async openJobs() {
    if (this.jobs) return;
    this.jobs = await DoomLearningJobs.open({ supervisor: this.supervisor!, store: this.store('jobs.json', decodeDoomLearningJobs),
      proposalStore: id => this.proposalStore(id), recover: () => this.evaluator!.recover(), settled: () => this.collectIncidents(),
      proposalOptions: async (id, store, signal, selectedProvider = 'codex') => {
        signal.throwIfAborted();
        const incident = await this.incidents!.capture(id, signal);
        const saved = incident.evidence;
        const context = contentRevision('doom-user-context', { objective: saved.view.pendingObjective ?? saved.view.objective,
          skills: activeSkills(saved.view.skills ?? []), binding: saved.learning!.binding, overrides: saved.learning!.overrides ?? {} });
        const record = async (value: unknown) => {
          await this.store('provider/' + id + '.json', input => input).save(value);
          const tokens = supervisorTokens(value, id); if (tokens) this.providerTokens.set(id, tokens);
        };
        const provider = this.options.proposalProvider ? await this.options.proposalProvider(record, selectedProvider)
          : selectedProvider === 'codex' ? await CodexCliSupervisor.open<DoomPolicy, DoomProposalEvidence>({ record })
          : await ClaudeCodeSupervisor.open<DoomPolicy, DoomProposalEvidence>({ unrestricted: true, effort: 'medium', record });
        return { id, store, provider, supervisor: this.supervisor!, models: this.models!, executables: new ExecutableStore(join(this.options.directory, 'executables')),
          unrestricted: true, trainingCatalog: doomTrainingCatalog(this.manifest!.contract), testsSavedSituation: true, historicalExperiments: this.historicalExperiments, ledger: this.generation!, limits: this.manifest!.proposalLimits, capture: () => {
            if (!same(context, this.game().supervisorContext())) throw new Error('User guidance changed while saving the learning situation');
            return structuredClone(saved);
          },
          failureReceipt: error => error instanceof SupervisorFailure ? error.receipt : undefined };
      } });
    for (const job of this.jobs.snapshot().jobs) if (job.command.kind === 'propose') {
      const id = job.command.id, record = await this.store('provider/' + id + '.json', input => input).load();
      const tokens = supervisorTokens(record, id); if (tokens) this.providerTokens.set(id, tokens);
    }
    await this.openAutomation();
  }
  private async openAutomation() {
    if (this.automation || this.options.backgroundLearning === false) return;
    const preferences = await this.store('automation-preferences.json', value => z.strictObject({ provider: z.enum(['codex', 'claude']) }).parse(value)).load();
    this.automaticProvider = preferences?.provider ?? 'codex';
    // Keep the initial observed goal across restarts, including before the first paid review.
    const goalStore = this.store('automation-goal.json', value => z.strictObject({ objective: z.string() }).parse(value));
    let initialGoal = await goalStore.load();
    if (!initialGoal) { initialGoal = { objective: this.session!.snapshot().objective }; await goalStore.save(initialGoal); }
    const goals = new DoomGoalReview(initialGoal.objective);
    this.automation = await AutonomousLearning.open<DoomLearningMark>({
      store: this.store('automation.json', value => doomAutonomousState.parse(value)), id: randomUUID,
      observe: previous => {
        const view = this.session!.snapshot(), now = Date.now();
        return observeDoomLearning(view, previous, now, { initialObjective: goals.initialObjective,
          goalSettled: goals.settled(view.pendingObjective ?? view.objective, now),
          bootstrapPlanner: this.options.bootstrapPlanner !== false && this.supervisor!.binding.current().artifact.model.id !== 'prepared-doom-jev' });
      },
      activationObservation: () => doomActivationObservation(this.session!.snapshot()),
      busy: () => this.jobs!.busy,
      job: id => this.jobs!.snapshot().jobs.find(job => job.command.id === id),
      proposal: id => this.supervisor!.overview().journal.proposals.find(proposal => proposal.id === id),
      propose: async id => {
        const issue = this.automation?.snapshot().cycle?.mark.issues.at(-1);
        await this.jobs!.start({ kind: 'propose', id, provider: this.automaticProvider, proposalKind: doomAutomaticProposalKind(issue, this.session!.snapshot().planningMode) });
      },
      evaluate: async (id, proposalId) => { await this.jobs!.start({ kind: 'evaluate', id, proposalId }); },
      activate: async id => {
        const session = this.session!, view = session.snapshot();
        const apply = async () => {
          await this.supervisor!.activate(id);
          const proposal = this.supervisor!.overview().journal.proposals.find(proposal => proposal.id === id)!;
          await session.reportLearningImprovement(proposal.reason);
        };
        if (!view.running && !view.busy && !view.manualChoiceRequired && !view.worlds.some(world => world.role === 'experiment' || world.controller === 'human')
          && view.worlds.find(world => world.id === view.mainId)?.plan?.status !== 'running') {
          session.cancelLearningActivation(id); await apply(); return 'activated';
        }
        return session.queueLearningActivation(id, apply);
      },
      cancel: async cycle => {
        this.session!.cancelLearningActivation(cycle.proposalId);
        for (const id of [cycle.proposalId, cycle.evaluationId]) if (this.jobs!.snapshot().jobs.some(job => job.command.id === id)) await this.jobs!.cancel(id);
        await this.jobs!.join();
      },
    }, true);
    this.automationTimer = setInterval(() => {
      if (!this.closing) void this.automation!.tick().catch(error => { this.automationError = error instanceof Error ? error.message : String(error); });
    }, 1000);
    this.automationTimer.unref();
  }
  private async collectIncidents() {
    if (!this.incidents || !this.supervisor) return;
    const now = Date.now();
    const retained = this.supervisor.overview().journal.proposals.filter(proposal => proposal.status === 'proposed' && proposal.expiresAt > now);
    await this.incidents.collect(new Set(retained.map(proposal => proposal.id)));
  }
  private proposalStore(id: string): JsonFileStore<DoomProposalRecord> { z.string().uuid().parse(id); return this.store('proposals/' + id + '.json', decodeDoomProposal); }
  private store<T>(file: string, decode: (value: unknown) => T): JsonFileStore<T> {
    let store = this.stores.get(file); if (!store) { store = new JsonFileStore(join(this.options.directory, file), decode); this.stores.set(file, store); } return store;
  }
  private adapter(): VersionRef { return { id: 'doom-learning-adapter', version: this.options.build.revision.version }; }
  private builtin(): VersionRef { return { id: 'doom-jev-host', version: this.options.build.revision.version }; }
  private game(): Session { if (this.closing) throw new Error('Learning service is closing'); if (!this.session) throw new Error('Learning service has no game'); return this.session; }
  private ready(): void { this.game(); if (!this.enabled || !this.jobs) throw new Error('Enable learning first'); }
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
