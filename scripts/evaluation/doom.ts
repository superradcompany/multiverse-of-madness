import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { BudgetExhausted, compareRevisions, type EvaluationContract, type EvaluationOutput, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { Session } from '../../examples/doom/server/src/session.ts';
import { Jev, type Decision } from '../../examples/doom/server/src/jev.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { navigateDoomInputs } from '../../examples/doom/server/src/doom-navigation.ts';
import type { GameState, Step } from '../../examples/doom/contracts/src/game.ts';
import type { WorldView, SessionView } from '../../examples/doom/contracts/src/session.ts';
import { doomScenario } from './doom-scenarios.ts';
import { EvaluationWorld } from './doom-runtime.ts';
import { revisionExperiment } from './revision-experiment.ts';

const { values } = parseArgs({ options: { 'simulation-ticks': { type: 'string', default: '2100' }, 'model-calls': { type: 'string', default: '8' }, scenarios: { type: 'string', default: '0,4' }, 'candidate-threshold': { type: 'string', default: '0.75' }, output: { type: 'string' }, supervise: { type: 'boolean', default: false } } });
const simulation = Number(values['simulation-ticks']), modelCalls = Number(values['model-calls']), candidateThreshold = Number(values['candidate-threshold']);
const ids = values.scenarios!.split(',').map(Number);
if (!Number.isFinite(candidateThreshold) || candidateThreshold < 0 || candidateThreshold > 1 || !Number.isSafeInteger(simulation) || simulation < 35 || !Number.isSafeInteger(modelCalls) || modelCalls < 1
  || ids.some(id => !Number.isInteger(id) || id < 0 || id > 5) || new Set(ids).size !== ids.length) throw new Error('Invalid evaluation limits or scenario IDs');
const root = resolve(values.output ?? `artifacts/harness-evaluation/${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(dirname(root), { recursive: true });
await mkdir(root, { recursive: false });
const scenarios = ids.map(doomScenario);
const sourceRoots = ['examples/doom/server/src', 'examples/doom/contracts/src', 'examples/doom/bridge/src', 'harness/src', 'scripts/evaluation'];
const files = ['assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'package.json', 'package-lock.json', 'tsconfig.json', 'harness/package.json', 'harness/package-lock.json', 'harness/tsconfig.json', 'harness/tsconfig.build.json', ...(
  await Promise.all(sourceRoots.map(async directory => (await readdir(directory, { recursive: true }))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => join(directory, file))))
).flat()];
const builds = Object.fromEntries(await Promise.all(files.map(async file => {
  const bytes = await readFile(file);
  if (!file.startsWith('assets/')) { const target = join(root, 'source', file); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, bytes); }
  return [file, createHash('sha256').update(bytes).digest('hex')];
})));
const profiles = { baseline: { threshold: 0, horizon: 70, branches: 2, paceMs: 0, frameTicks: 1 }, candidate: { threshold: candidateThreshold, horizon: 70, branches: 2, paceMs: 0, frameTicks: 1 } };
type Profile = typeof profiles.baseline;
const artifact = (id: string, policy: Profile): LearningRevision<Profile> => {
  const data = { policy, prompts: {}, skills: [], executor: contentRevision('doom-session', builds),
    adapter: contentRevision('doom-replay-runtime', { engine: builds['assets/wasmdoom.wasm'], wad: builds['assets/freedoom1.wad'], runtime: builds['scripts/evaluation/doom-runtime.ts'] }),
    model: { id: 'jev-provider-default', version: 'unpinned-provider-model' } };
  return { ...data, revision: contentRevision(id, data) };
};
const artifacts = { baseline: artifact('doom-direct', profiles.baseline), candidate: artifact('doom-futures', profiles.candidate) };
const baseline = artifacts.baseline.revision, candidate = artifacts.candidate.revision;
const contract: EvaluationContract<{ setup: Step[] }> = {
  id: 'doom-total-budget-v1', evaluator: { id: 'doom-survival-progress', version: '1' }, scenarios,
  budget: { simulationUnit: 'doom-ticks', limits: { simulation, modelCalls } }, maxRunMs: 120_000,
  acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
};
await writeFile(join(root, 'manifest.json'), JSON.stringify({ contract, baseline, candidate, artifacts, profiles, builds, node: process.version,
  limitations: ['Replay-based cloning includes reconstruction ticks in the total budget; this is not a VM-fork or wall-time benchmark.', 'Token usage is recorded, not hard-capped: the provider exposes usage after the request.', 'The provider can be nondeterministic and its default model is not pinned. Each decision records the reported model. The explicit seed names Doom initialization; it does not seed Jev.', 'These diagnostic starts were used previously and are not new held-out acceptance scenarios.'] }, null, 2));
type Evidence = { initial: GameState; final: GameState; session: SessionView; frames: WorldView[]; decisions: Array<{ state: GameState; decision: Decision }> };
const control = new AbortController();
process.once('SIGINT', () => control.abort(new Error('Interrupted by user')));
const evaluate = (signal: AbortSignal) => compareRevisions(contract, baseline, candidate, {
  run: async (revision, scenario, ledger, signal): Promise<EvaluationOutput<Evidence>> => {
    const selected = Object.values(artifacts).find(item => item.revision.id === revision.id && item.revision.version === revision.version);
    if (!selected) throw new Error('Unknown immutable evaluation revision');
    const profile = selected.policy;
    const source = await EvaluationWorld.create(`${scenario.id}-${revision.id}`, ledger, signal);
    let session: Session | undefined;
    try {
      for (const command of scenario.input.setup) await source.step(command, 'scenario-setup');
      const initial = await source.state();
      const decisions: Evidence['decisions'] = [];
      const frames: WorldView[] = [];
      let decisionSequence = 0;
      const jev = new Jev();
      const model: ConstructorParameters<typeof Session>[0] = { decide: (...args) =>
        ledger.run({ owner: `decision-${decisionSequence++}`, operation: 'jev', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
          const [state, objective, history, current, ...context] = args;
          const result = await jev.decide(state, objective, history, AbortSignal.any([current, signal]), ...context);
          if (!result.usage) throw new Error('Jev did not report token usage');
          decisions.push({ state: structuredClone(state), decision: structuredClone(result) });
          return { value: result, usage: { modelCalls: 1, ...result.usage } };
        }, signal),
      };
      session = new Session(model, profile);
      session.setRecorder(async world => { frames.push(structuredClone(world)); });
      session.setControls(async (state, inputs, navigation) => navigateDoomInputs(state, inputs, await geometryFor(state, true, true), navigation));
      await session.initialize(source);
      const stop = () => { void session!.pause(); };
      signal.addEventListener('abort', stop, { once: true });
      let terminal = false;
      session.on('change', () => {
        const view = session!.snapshot(), main = view.worlds.find(world => world.id === view.mainId)!;
        if (!terminal && (!main.state.alive || main.state.phase !== 'level' || main.state.map !== initial.map)) { terminal = true; stop(); }
      });
      try { session.resume(); await session.idle(); }
      finally { signal.removeEventListener('abort', stop); }
      const view = session.snapshot(), final = view.worlds.find(world => world.id === view.mainId)!.state;
      const budgetEnded = session.failureCause instanceof BudgetExhausted;
      if (view.error && !budgetEnded) throw session.failureCause ?? new Error(view.error);
      await new JsonFileStore(join(root, `${scenario.id}-${revision.id}-session.json`), x => x).save(session.checkpoint());
      return { ending: terminal ? 'terminal' : budgetEnded ? 'budget' : 'complete', evidence: JSON.parse(JSON.stringify({ initial, final, session: view, frames, decisions })) as Evidence };
    } finally { if (session) await session.close(); else await source.destroy(); }
  },
  measure: evidence => {
    const stats = evidence.session.stats!, exited = evidence.final.map !== evidence.initial.map || evidence.final.phase === 'intermission' || evidence.final.phase === 'finale';
    return { score: Number(exited) * 100000 + Number(evidence.final.alive) * 10000 + stats.kills * 100 + stats.cells + evidence.final.health,
      kills: stats.kills, health: evidence.final.health, cells: stats.cells, gameSeconds: stats.seconds, exited: Number(exited) };
  },
  persistBudget: (id, snapshot) => new JsonFileStore(join(root, `${id.split('/').slice(-2).join('-')}-budget.json`), x => x).save(snapshot),
  persistRun: run => new JsonFileStore(join(root, `${run.scenarioId}-${run.role}-result.json`), x => x).save(run),
}, signal);
const report = values.supervise ? await revisionExperiment({ directory: root, ...artifacts,
  contract: contentRevision('doom-evaluation-contract', contract),
  context: contentRevision('doom-evaluation-context', { objective: 'survive and reach the exit', overrides: {}, builds }), evaluate,
}, control.signal) : await evaluate(control.signal);
await writeFile(join(root, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output: root, accepted: report.accepted, reason: report.reason, meanGain: report.meanGain,
  runs: report.runs.map(run => ({ role: run.role, scenario: run.scenarioId, status: run.status, ending: run.ending, metrics: run.metrics, error: run.error })) }, null, 2));
