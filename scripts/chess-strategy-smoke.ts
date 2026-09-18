import './runtime-env.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Image, Sandbox, SandboxNotFoundError } from 'microsandbox';
import { BudgetLedger, type BudgetSnapshot, type ExecutorLimits, type LearningRevision } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore, contentRevision } from '@multiverse/gameplay-harness/node';
import { CodexCliSupervisor } from '../packages/supervisor-codex/src/provider.ts';
import { MicrosandboxExecutor, type ExecutorRunRecord } from '../packages/executor-microsandbox/src/executor.ts';
import { ChessAdapter, ChessFixtureModel } from '../examples/chess/adapter.ts';
import { ChessJevModel } from '../examples/chess/jev.ts';
import { ChessPreparedModel } from '../examples/chess/prepared-model.ts';
import { ChessRuntimeStore } from '../examples/chess/runtime-store.ts';
import { ChessSession } from '../examples/chess/session.ts';
import { defaultChessPolicy } from '../examples/chess/policy.ts';
import { describeChess } from '../examples/chess/description.ts';
import { proposeChessStrategy, type ChessStrategyEvidence } from '../examples/chess/strategy-proposal.ts';
import type { ChessPolicy } from '../examples/chess/session-types.ts';

const reuse = process.argv[2] === '--verify';
if (process.argv[2] && (!reuse || !process.argv[3])) throw new Error('Usage: chess-strategy-smoke.ts [--verify EXISTING_DIRECTORY]');
const directory = reuse ? resolve(process.argv[3]!) : resolve(`artifacts/chess-strategy/${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) => new JsonFileStore(join(directory, name), data => data).save(value);
console.log(JSON.stringify({ directory, stage: 'starting' }));
const control = new AbortController();
process.once('SIGINT', () => control.abort(new Error('Qualification cancelled')));
process.once('SIGTERM', () => control.abort(new Error('Qualification cancelled')));
const store = new ExecutableStore(join(directory, 'sources')), adapter = new ChessAdapter(), runtime = new ChessRuntimeStore(join(directory, 'runtime'));
const jev = await ChessJevModel.open(join(directory, 'jev'));
// Mechanism-only baseline: expose every legal candidate unchanged. No chess strategy or opening is supplied.
const base = await store.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: { 'main.ts': `export default input => ({abi:'chess-preparation/1',guidance:'',plans:input.candidates.map(p=>({id:p.id,label:p.label,expectedBenefit:p.expectedBenefit})),experienceIndices:input.experience.map((_,i)=>i)});` } });
const fields = { executor: base.revision, adapter: adapter.version, model: contentRevision('chess-prepared-jev', { abi: 'chess-preparation/1', decision: jev.version }), policy: defaultChessPolicy, prompts: {}, skills: [] };
const baseline: LearningRevision<ChessPolicy> = { ...fields, revision: contentRevision('chess-learning-system', fields) };
const objective = 'win by checkmate';
const provider = reuse ? undefined : await CodexCliSupervisor.open<ChessPolicy, ChessStrategyEvidence>({ record: value => save('generation.json', value) });
// Retained API fields; the unrestricted Codex provider does not apply these legacy cutoffs.
const providerLimits = { timeoutMs: 300000, maxInputBytes: 65536, maxOutputBytes: 65536, maxCostMicros: 2000000 };
const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: {} }, value => save('usage.json', value), reuse ? JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')) as BudgetSnapshot : undefined);
const proposal = reuse ? JSON.parse(await readFile(join(directory, 'proposal.json'), 'utf8')) as Awaited<ReturnType<typeof proposeChessStrategy>> : await proposeChessStrategy({ id: randomUUID(), current: baseline, origin: { activation: { epoch: 0, revision: baseline.revision }, context: contentRevision('chess-context', { objective }) },
  objective, game: describeChess(adapter.version, runtime.capabilities), contract: { id: 'chess-strategy-integration-only', version: '1' }, observations: [], provider: provider!, limits: providerLimits, store, ledger }, control.signal);
if (!reuse) await save('proposal.json', proposal);
console.log(JSON.stringify({ stage: 'generated', revision: proposal.artifact.revision, tokens: proposal.receipt.usage }));
const image = await Image.get('docker.io/library/node:24-alpine');
const records: ExecutorRunRecord[] = reuse ? JSON.parse(await readFile(join(directory, 'executor-runs.json'), 'utf8')) : [];
const executor = new MicrosandboxExecutor({ image: `docker.io/library/node@${image.manifestDigest}`, record: async record => {
  const index = records.findIndex(value => value.id === record.id);
  if (index < 0) records.push(record); else records[index] = record;
  await save('executor-runs.json', records);
} });
const limits: ExecutorLimits = { timeoutMs: 20000, cpus: 1, memoryMiB: 256, maxInputBytes: 65536, maxOutputBytes: 65536 };
let decisions = reuse ? (await readdir(directory)).filter(name => /^preparation-\d+\.json$/.test(name)).length : 0, session: ChessSession | undefined;
control.signal.addEventListener('abort', () => { void session?.pause().catch(() => {}); }, { once: true });
const model = new ChessPreparedModel(proposal.artifact, { store, executor, ledger, limits, decision: jev, record: value => save(`preparation-${++decisions}.json`, value) });
// Test-only binding: the proposal is used in a separate integration run, not qualified or activated in the user's session.
const binding = { identity: { id: 'chess-strategy-isolated-smoke', version: '1' }, current: () => ({ activation: { epoch: 0, revision: proposal.artifact.revision }, artifact: proposal.artifact }), resolve: () => proposal.artifact, model: () => model };
try {
  session = reuse ? await ChessSession.restore(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), binding) : await ChessSession.create(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), {}, binding);
  for (let cycle = 0; cycle < (reuse ? 0 : 4); cycle++) { control.signal.throwIfAborted(); await session.step(); }
  const before = session.snapshot(), main = before.worlds.find(world => world.meta.id === before.mainId)!;
  assert.ok(main.state.ply >= 2);
  await session.detach();
  session = await ChessSession.restore(join(directory, 'session'), runtime, adapter, new ChessFixtureModel(), binding);
  // Persistence is JSON: compare every serialized field, excluding absent optional undefined values.
  assert.deepEqual(JSON.parse(JSON.stringify(session.snapshot())), JSON.parse(JSON.stringify(before)));
  assert.equal((await session.replay()).lastTick, main.state.ply);
  assert.ok(records.length > 0 && records.every(record => record.phase === 'released'));
  for (const record of records) await assert.rejects(Sandbox.get(record.id), SandboxNotFoundError);
  await save('report.json', { result: 'integration-passed', verificationOnly: reuse, proposal: proposal.artifact.revision, main: main.state, attempts: before.attempts, preparations: decisions, vmCount: records.length,
    limitations: ['Bootstrap integration only; no independent quality comparison or live activation.', 'No human edits to generated source.', 'Game worlds are local exact board-history copies; strategy code runs in real networkless VMs.', 'Jev makes the move decisions.'] });
  console.log(JSON.stringify({ stage: 'complete', directory, moves: main.state.moves, preparations: decisions, allExecutorVmsReleased: true }));
} finally {
  await session?.detach();
  for (const record of records.filter(value => value.phase !== 'released')) await executor.recover(record);
}
