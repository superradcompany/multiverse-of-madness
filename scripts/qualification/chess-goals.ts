import '../runtime-env.ts';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { BudgetLedger, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../../packages/executor-microsandbox/src/executor.ts';
import { ChessAdapter, ChessFixtureModel } from '../../examples/chess/adapter.ts';
import { ChessJevModel } from '../../examples/chess/jev.ts';
import { ChessPreparedModel } from '../../examples/chess/prepared-model.ts';
import { ChessSession } from '../../examples/chess/session.ts';
import { ChessRuntimeStore } from '../../examples/chess/runtime-store.ts';
import { defaultChessPolicy } from '../../examples/chess/policy.ts';
import type { ChessPolicy } from '../../examples/chess/session-types.ts';

// Authored mechanism fixture. Real VM preparation and Jev, not autonomous goal-quality qualification.
const directory = resolve(`artifacts/chess-goals/${new Date().toISOString().replaceAll(':', '-')}`);
const save = (name: string, value: unknown) => new JsonFileStore(join(directory, name), value => value).save(value);
const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter(), runtime = new ChessRuntimeStore(join(directory, 'runtime'));
const source = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `export default input => ({
  abi:'chess-preparation/2', guidance:'Respect the user objective; the opponent plays competitively.',
  plans:input.candidates.map(p=>({id:p.id,label:p.label,expectedBenefit:p.expectedBenefit})),experienceIndices:[],
  temporaryGoal:{key:'pursueMate',instruction:'Seek a sound continuation toward checkmate.',reason:'Bounded lifecycle qualification.',evidence:['current-state'],duration:8,target:{kind:'checkmate'}}
});` } });
const jev = await ChessJevModel.open(join(directory, 'jev'));
const fields = { executor: source.revision, adapter: adapter.version, model: contentRevision('chess-prepared-goals', { decision: jev.version }), policy: defaultChessPolicy, prompts: {}, skills: [] };
const artifact: LearningRevision<ChessPolicy> = { ...fields, revision: contentRevision('chess-learning-system', fields) };
const image = await Image.get('docker.io/library/node:24-alpine');
if (!image.manifestDigest) throw new Error('Executor image must be pinned');
const records: ExecutorRunRecord[] = [];
const executor = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  const index = records.findIndex(item => item.id === record.id); if (index < 0) records.push(record); else records[index] = record;
  await save('executor-runs.json', records);
} });
const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: {} }, value => save('usage.json', value));
let calls = 0;
const model = new ChessPreparedModel(artifact, { store, executor, ledger, decision: jev,
  limits: { timeoutMs: 20000, cpus: 1, memoryMiB: 256, maxInputBytes: 65536, maxOutputBytes: 65536 }, record: value => save(`preparation-${++calls}.json`, value) });
const binding = { identity: { id: 'chess-goals-isolated-check', version: '1' }, current: () => ({ activation: { epoch: 0, revision: artifact.revision }, artifact }), resolve: () => artifact, model: () => model };
let session: ChessSession | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void session?.pause(); });
try {
  session = await ChessSession.create(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), { threshold: 1 }, binding);
  // Force a comparison without depending on Jev confidence. The actual moves still come from Jev.
  await session.step(true);
  const forked = session.snapshot(), parent = forked.worlds.find(world => world.meta.id === forked.mainId)!;
  assert.ok(forked.batch?.complete); assert.equal(parent.state.ply, 0);
  assert.ok(parent.temporaryGoal); assert.equal(parent.temporaryGoal.record.expiresAt, 8);
  for (const child of forked.worlds.filter(world => world.meta.role === 'experiment')) {
    assert.equal(child.temporaryGoal!.record.id, parent.temporaryGoal.record.id);
    assert.equal(child.temporaryGoal!.record.expiresAt, 8);
  }
  await session.step(); const selected = session.snapshot(); await session.detach();
  session = await ChessSession.restore(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), binding);
  assert.deepEqual(JSON.parse(JSON.stringify(session.snapshot())), JSON.parse(JSON.stringify(selected)));
  const ply = selected.worlds.find(world => world.meta.id === selected.mainId)!.state.ply;
  assert.equal((await session.replayFrame(ply)).world.temporaryGoal!.record.id, parent.temporaryGoal.record.id);
  await save('report.json', { result: 'passed', calls, snapshot: selected, limitations: ['Authored strategy fixture; not autonomous generation or chess strength.', 'Board worlds use local exact histories; strategy preparation runs in real isolated VMs.'] });
} finally {
  await session?.detach();
  for (const record of records.filter(record => record.phase !== 'released')) await executor.recover(record);
}
assert.ok(records.length > 0 && records.every(record => record.phase === 'released'));
for (const record of records) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
await save('cleanup.json', { released: records.map(record => record.id) });
console.log(JSON.stringify({ directory, result: 'passed', preparations: calls, executorVmsRemoved: records.length }));
