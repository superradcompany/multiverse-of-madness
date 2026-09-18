import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandbox, SandboxNotFoundError } from 'microsandbox';
import { BudgetLedger, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../packages/executor-microsandbox/src/executor.ts';
import { ChessAdapter, ChessFixtureModel } from '../examples/chess/adapter.ts';
import { ChessJevModel } from '../examples/chess/jev.ts';
import { ChessPreparedModel } from '../examples/chess/prepared-model.ts';
import { ChessRuntimeStore } from '../examples/chess/runtime-store.ts';
import { ChessSession } from '../examples/chess/session.ts';
import type { ChessPolicy } from '../examples/chess/session-types.ts';
import type { ChessStrategyEvaluationEvidence } from '../examples/chess/strategy-evaluation.ts';
import type { ChessSave } from '../examples/chess/runtime.ts';

const [sourceDirectory, scenarioId, role, selected] = process.argv.slice(2);
if (!sourceDirectory || !scenarioId || !['baseline', 'candidate'].includes(role ?? '') || !selected) throw new Error('Usage: chess-branch-diagnostic.ts COMPARISON_DIRECTORY SCENARIO_ID baseline|candidate OBSERVED_MOVE');
const sourceRoot = resolve(sourceDirectory);
const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8')) as {
  baseline: LearningRevision<ChessPolicy>; candidate: LearningRevision<ChessPolicy>; image: string;
  contract: { scenarios: Array<{ id: string; input: { objective: string } }> };
};
const comparison = JSON.parse(await readFile(join(sourceRoot, 'comparison.json'), 'utf8')) as {
  runs: Array<{ scenarioId: string; role: string; status: string; revision: unknown; evidence: ChessStrategyEvaluationEvidence }>;
};
const run = comparison.runs.find(run => run.scenarioId === scenarioId && run.role === role && run.status === 'complete');
const incident = run?.evidence.moves.find(move => move.selected === selected && move.actor === 'strategy');
assert.ok(incident, 'No completed observed strategy move matches the requested incident');
const artifact = role === 'candidate' ? manifest.candidate : manifest.baseline;
assert.deepEqual(run!.revision, artifact.revision);
const { revision, ...fields } = artifact; assert.deepEqual(revision, contentRevision(revision.id, fields));
const scenario = manifest.contract.scenarios.find(scenario => scenario.id === scenarioId); assert.ok(scenario);
const directory = resolve(`artifacts/chess-branch-diagnostic/${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) => new JsonFileStore(join(directory, name), input => input).save(value);
const store = new ExecutableStore(join(directory, 'sources'));
const source = await new ExecutableStore(join(sourceRoot, 'sources')).get(artifact.executor);
assert.deepEqual((await store.put(source.source)).revision, artifact.executor);
class HistoricalRuntime extends ChessRuntimeStore {
  constructor(root: string, private readonly saved: ChessSave) { super(root); }
  override async create(id: string, signal: AbortSignal) { signal.throwIfAborted(); return this.createFrom(id, this.saved); }
}
const runtime = new HistoricalRuntime(join(directory, 'runtime'), incident.before), adapter = new ChessAdapter();
const jev = await ChessJevModel.open(join(directory, 'jev'));
assert.deepEqual(artifact.model, contentRevision('chess-prepared-jev', { abi: 'chess-preparation/1', decision: jev.version }));
const records: ExecutorRunRecord[] = [];
const recordStore = new JsonFileStore<ExecutorRunRecord[]>(join(directory, 'executor-runs.json'), value => value as ExecutorRunRecord[]);
const executor = new MicrosandboxExecutor({ image: manifest.image, record: async record => {
  const index = records.findIndex(item => item.id === record.id); if (index < 0) records.push(record); else records[index] = record;
  await recordStore.save(records);
} });
const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: {} }, value => save('usage.json', value));
const model = new ChessPreparedModel(artifact, { store, executor, ledger, limits: { timeoutMs: 20000, cpus: 1, memoryMiB: 256, maxInputBytes: 65536, maxOutputBytes: 65536 }, decision: jev,
  record: value => save(`preparations/${randomUUID()}.json`, value) });
const binding = { identity: contentRevision('chess-isolated-branch-diagnostic', { sourceRoot, scenarioId, role, selected }),
  current: () => ({ activation: { epoch: 0, revision: artifact.revision }, artifact }), resolve: () => artifact, model: () => model };
let session: ChessSession | undefined;
const control = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { control.abort(new Error('Diagnostic cancelled')); void session?.pause().catch(() => {}); });
console.log(JSON.stringify({ stage: 'started', directory, source: incident.before.fen }));
try {
  session = await ChessSession.create(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), artifact.policy, binding);
  if (scenario.input.objective !== session.snapshot().objective) await session.guide(scenario.input.objective);
  const before = session.snapshot(); assert.deepEqual(before.worlds[0]!.state, incident.before);
  await save('manifest.json', { artifact, sourceRoot, scenarioId, role, selected, before,
    limitations: ['One real harness decision from an observed diagnostic state, not a general quality evaluation.', 'Uses the same active preparation for both sides, matching live self-play.', 'Board histories are local; preparation runs in real VMs. The live demo is unchanged.'] });
  for (let cycle = 0; cycle < 4; cycle++) {
    control.signal.throwIfAborted(); await session.step(); const snapshot = session.snapshot(); await save(`cycle-${cycle}.json`, snapshot);
    const main = snapshot.worlds.find(world => world.meta.id === snapshot.mainId)!;
    console.log(JSON.stringify({ stage: 'cycle', cycle, attempts: snapshot.attempts, selectedPlies: main.state.ply, batch: snapshot.batch?.complete }));
    if (!snapshot.batch && main.state.ply > incident.before.ply) break;
  }
  const result = session.snapshot(), main = result.worlds.find(world => world.meta.id === result.mainId)!;
  assert.ok(!result.batch && main.state.ply > incident.before.ply, 'The diagnostic did not settle a new selected continuation');
  await session.detach(); session = await ChessSession.restore(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), binding);
  assert.deepEqual(JSON.parse(JSON.stringify(session.snapshot())), JSON.parse(JSON.stringify(result)));
  assert.ok(records.every(record => record.phase === 'released'));
  for (const record of records) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  const report = { source: incident.before, previouslySelected: selected, moves: main.state.moves.slice(incident.before.ply), valueChange: adapter.value(main.state) - adapter.value(incident.before),
    attempts: result.attempts, archivedAlternatives: result.worlds.filter(world => world.meta.id !== before.mainId && world.meta.id !== result.mainId).map(world => ({ moves: world.state.moves.slice(incident.before.ply), valueChange: adapter.value(world.state) - adapter.value(incident.before) })),
    replay: await session.replay(), vmCount: records.length, allReleasedAndAbsent: true, reconnected: true };
  await save('report.json', report); console.log(JSON.stringify({ stage: 'complete', directory, moves: report.moves, valueChange: report.valueChange, forks: report.attempts.forks, vmCount: records.length }));
} finally { await session?.detach(); await ledger.join(); for (const record of records.filter(record => record.phase !== 'released')) await executor.recover(record); }
