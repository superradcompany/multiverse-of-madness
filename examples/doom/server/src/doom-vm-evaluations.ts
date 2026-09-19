import type { SessionContinuation } from './session.ts';
import { withDoomEvaluationAllowance, type DoomEvaluationContract } from './doom-evaluation-allowance.ts';
import { withDoomIncident, requireDoomIncidentImprovement, doomIncidentRejection } from './doom-incident-evaluation.ts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, type BudgetLedger, type QualificationRequest, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { stepSchema, type Step } from '../../contracts/src/game.ts';
import { DoomEvaluationVms, decodeDoomEvaluationVms, doomIncidentCheckpointSchema, type DoomIncidentCheckpoint, type DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';
import { qualifyDoomRevision, type DoomEvaluationContext, type DoomEvaluationEvidence } from './doom-revision-evaluation.ts';
import type { DoomPolicy } from './doom-policy.ts';
import type { DoomLearningModels } from './doom-learning-models.ts';
import { openDoomEvaluationRecording } from './doom-evaluation-recording.ts';

export interface DoomVmScenario { setup: Step[]; minimumSelectedTicks?: number; incident?: DoomIncidentCheckpoint; continuation?: SessionContinuation }
export interface DoomVmEvaluationOptions {
  directory: string;
  /** Frozen scenarios, metric identity, per-run budgets and acceptance rule. Part of supervisor rules before proposing. */
  contract: DoomEvaluationContract;
  runtime: DoomEvaluationVmPorts;
  models(ledger: BudgetLedger): DoomLearningModels;
  context(): { revision: VersionRef; value: DoomEvaluationContext };
  measure(evidence: DoomEvaluationEvidence): Record<string, number>;
}

/** Application composition: real VM trials, durable evidence and resource recovery per proposal. */
export class DoomVmEvaluations {
  private readonly contract: DoomEvaluationContract;
  private readonly stores = new Map<string, JsonFileStore<unknown>>();
  private active = false;
  private recovering = false;
  constructor(private readonly options: DoomVmEvaluationOptions) {
    this.options = { ...options };
    this.contract = structuredClone(options.contract);
    for (const scenario of this.contract.scenarios) scenario.input = z.strictObject({ setup: z.array(stepSchema), incident: doomIncidentCheckpointSchema.optional(), continuation: z.custom<SessionContinuation>().optional(), minimumSelectedTicks: z.number().int().nonnegative().optional() }).parse(scenario.input);
    if (canonicalJson(this.contract) !== canonicalJson(options.contract)) throw new Error('VM evaluation contract must already be normalized');
  }
  get version(): VersionRef { return contentRevision('doom-evaluation-contract', this.contract); }

  /** Call under exclusive application ownership before admitting any new learning work. Never resumes trials. */
  async recover(): Promise<void> {
    if (this.active || this.recovering) throw new Error('VM evaluator is already working');
    this.recovering = true;
    try {
      const entries = await readdir(this.options.directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;
      });
      for (const entry of entries) {
        if (!z.string().uuid().safeParse(entry.name).success) continue;
        if (!entry.isDirectory()) throw new Error('Evaluation job path must be a directory, not a link or file');
        const store = this.resourceStore(entry.name);
        // A crash before resource admission can leave only the immutable request manifest.
        if (await store.load()) await DoomEvaluationVms.open(store, this.options.runtime);
      }
    } finally { this.recovering = false; }
  }

  async qualify(input: QualificationRequest<DoomPolicy>, signal: AbortSignal, incident?: DoomIncidentCheckpoint, continuation?: SessionContinuation) {
    if (this.active || this.recovering) throw new Error('VM evaluator is already working');
    const request = structuredClone(input); z.string().uuid().parse(request.proposalId);
    if (canonicalJson(request.contract) !== canonicalJson(this.version)) throw new Error('VM evaluation contract changed');
    const context = structuredClone(this.options.context());
    if (canonicalJson(context.revision) !== canonicalJson(request.context)) throw new Error('Evaluation user context changed before dispatch');
    if (continuation && !incident) throw new Error('Incident knowledge requires a captured game state');
    const scenarios = incident ? withDoomIncident(this.contract, incident, continuation) : this.contract;
    const contract = withDoomEvaluationAllowance(scenarios, request.baseline, request.candidate, context.value);
    const evaluationRequest = { ...request, contract: contentRevision('doom-evaluation-contract', contract) };
    signal.throwIfAborted(); this.active = true;
    let owner: DoomEvaluationVms | undefined;
    const directory = join(this.options.directory, request.proposalId);
    const write = (file: string, value: unknown) => this.store(join(directory, file)).save(value);
    const runPath = (id: string) => 'runs/' + contentRevision('doom-evaluation-run', id).version.slice(7);
    try {
      // The controller and job owner also fence retries; the experiment itself keeps a durable one-shot receipt.
      const manifest = this.store(join(directory, 'manifest.json'));
      if (await manifest.load() !== undefined) throw new Error('VM evaluation was already admitted; it cannot be replayed');
      await manifest.save(this.contract.allowance
        ? { version: 3, request, evaluationRequest, context, templateContract: this.contract, contract, createdAt: Date.now() }
        : incident
        ? { version: 2, request, evaluationRequest, context, templateContract: this.contract, contract, createdAt: Date.now() }
        : { version: 1, request, context, contract, createdAt: Date.now() });
      owner = await DoomEvaluationVms.open(this.resourceStore(request.proposalId), this.options.runtime);
      const resources = owner;
      const qualification = await qualifyDoomRevision(evaluationRequest, {
        contract, context: context.value,
        models: ledger => this.options.models(ledger),
        continuation: scenario => scenario.input.continuation,
        minimumSelectedTicks: scenario => scenario.input.minimumSelectedTicks ?? 0,
        create: (id, scenario, ledger, current) => resources.create(id, ledger, current, scenario.input.setup, scenario.input.incident),
        checkpoints: id => resources.checkpoints(id), cleanup: id => resources.cleanup(id),
        recording: id => openDoomEvaluationRecording(join(directory, runPath(id))),
        measure: evidence => this.options.measure(evidence),
        persistSession: (id, value) => write(runPath(id) + '/session.json', value),
        persistBudget: (id, value) => write(runPath(id) + '/budget.json', value),
        persistRun: value => write(runPath(value.id) + '/result.json', value),
        rejectAfterPair: incident ? (scenario, runs) => doomIncidentRejection(scenario, runs, this.contract) : undefined,
        persistComparison: value => {
          if (incident) requireDoomIncidentImprovement(value, this.contract);
          return write('comparison.json', value);
        },
      }, signal);
      // The supervisor pins the host's template; evidence pins the exact instantiated cases as well.
      return { ...qualification, contract: request.contract };
    } finally {
      try { await owner?.recover(); }
      finally { this.active = false; }
    }
  }
  private resourceStore(id: string) { return new JsonFileStore(join(this.options.directory, id, 'resources.json'), decodeDoomEvaluationVms); }
  private store(path: string) {
    let store = this.stores.get(path);
    if (!store) { store = new JsonFileStore(path, value => value); this.stores.set(path, store); } return store;
  }
}
