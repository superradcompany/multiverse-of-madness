import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POSITION } from 'chess.js';
import { type EvaluationContract, type LearningRevision } from '@multiverse/gameplay-harness';
import { ChessAdapter } from './adapter.ts';
import { defaultChessPolicy } from './policy.ts';
import { compareChessStrategies, type ChessStrategyScenario } from './strategy-evaluation.ts';
import type { ChessPolicy } from './session-types.ts';
import type { ChessDecisionModel } from './revisions.ts';

const baseline: LearningRevision<ChessPolicy> = { revision: { id: 'strategy', version: 'baseline' }, adapter: new ChessAdapter().version,
  executor: { id: 'test', version: '1' }, model: { id: 'test', version: '1' }, policy: defaultChessPolicy, prompts: {}, skills: [] };
const candidate = { ...baseline, revision: { id: 'strategy', version: 'candidate' } };
function contract(plies: number, moves: string[] = []): EvaluationContract<ChessStrategyScenario> {
  return { id: 'test-comparison', evaluator: { id: 'host-material', version: '1' }, maxRunMs: 1000,
    scenarios: [{ id: 'position', seed: 'same-history', input: { saved: { initialFen: DEFAULT_POSITION, moves }, objective: 'Win without unnecessary sacrifices', player: 'w', plies } }],
    budget: { simulationUnit: 'chess-plies', limits: { simulation: plies, modelCalls: plies } },
    acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: .1, maximumCaseRegression: 0 } };
}
function fixture(select: (ids: string[], own: boolean) => string): ChessDecisionModel {
  return { version: { id: 'fixture', version: '1' }, async decide(request) {
    const selected = select(request.candidates.map(p => p.id), request.state.turn === 'w');
    return { selected, confidence: 1, preferences: request.candidates.map(p => ({ id: p.id, probability: Number(p.id === selected) })), usage: { calls: 0 } };
  } };
}
const signal = () => new AbortController().signal;

test('paired chess strategy runs preserve histories, meter actual plies, and keep the opponent fixed', async () => {
  const calls: Array<{ revision: string; run: string }> = [];
  const input = contract(2, ['e4', 'e5']);
  const result = await compareChessStrategies({ baseline, candidate, contract: input, model: async (revision, _ledger, run) => {
    calls.push({ revision: revision.revision.version, run });
    return fixture((ids, own) => own ? (revision.revision.version === 'candidate' ? 'Nc3' : 'Nf3') : ids[0]!);
  } }, signal());
  assert.equal(result.accepted, false); assert.match(result.reason, /required mean improvement/);
  assert.equal(result.runs.length, 2);
  assert.deepEqual(calls.filter(c => c.run.endsWith('/opponent')).map(c => c.revision), ['baseline', 'baseline']);
  for (const run of result.runs) {
    assert.equal(run.status, 'complete'); assert.deepEqual(run.evidence!.before.moves, ['e4', 'e5']);
    assert.equal(run.evidence!.after.ply, 4); assert.deepEqual(run.evidence!.moves.map(m => m.actor), ['strategy', 'opponent']);
    for (const key of ['simulation', 'modelCalls'] as const) assert.equal(run.budget.entries.reduce((sum, e) => sum + (e.usage?.[key] ?? 0), 0), 2);
  }
  assert.deepEqual(input.scenarios[0]!.input.saved.moves, ['e4', 'e5']);
});

test('host metrics can qualify a winning move but refuse fabricated engine facts', async () => {
  const input = contract(1);
  input.scenarios[0]!.input.saved.initialFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  const result = await compareChessStrategies({ baseline, candidate, contract: input, model: async revision =>
    fixture(ids => revision.revision.version === 'candidate' ? ids.find(id => id.endsWith('#'))! : ids.find(id => id === 'Kf5')!) }, signal());
  assert.equal(result.accepted, true); assert.equal(result.runs[1]!.metrics!.wins, 1);
  const invalid = await compareChessStrategies({ baseline, candidate, contract: input, model: async revision => ({
    ...fixture(ids => ids[0]!), prepare: async request => revision.revision.version === 'candidate' ? { ...request, state: { ...request.state, ply: 900 } } : request,
  }) }, signal());
  assert.equal(invalid.accepted, false); assert.equal(invalid.runs[1]!.status, 'error');
  assert.match(invalid.runs[1]!.error!, /host-owned/); assert.equal(invalid.runs[1]!.evidence, undefined);
});

test('evaluation joins cancellation and cannot accept partial comparisons or mismatched allowances', async () => {
  const control = new AbortController(); let calls = 0;
  const result = await compareChessStrategies({ baseline, candidate, contract: contract(2), model: async () => ({
    version: { id: 'cancel', version: '1' }, decide: async () => { calls++; control.abort(new Error('cancel')); throw control.signal.reason; },
  }) }, control.signal);
  assert.equal(calls, 1); assert.equal(result.accepted, false); assert.equal(result.runs[0]!.status, 'cancelled');
  assert.ok(result.runs.every(run => run.budget.entries.every(entry => entry.status !== 'pending')));
  const bad = contract(2); bad.budget.limits.modelCalls = 1;
  await assert.rejects(compareChessStrategies({ baseline, candidate, contract: bad, model: async () => { throw new Error('must not start'); } }, signal()), /matching/);
});

test('an opening gain cannot hide failure to improve a host-pinned incident', async () => {
  const input = contract(1);
  input.scenarios[0]!.input.saved.initialFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  input.scenarios.push({ id: 'incident', seed: 'ordinary-start', input: { ...contract(1).scenarios[0]!.input, minimumGain: .1 } });
  const result = await compareChessStrategies({ baseline, candidate, contract: input, model: async revision => fixture(ids =>
    ids.includes('e4') ? 'e4' : revision.revision.version === 'candidate' ? ids.find(id => id.endsWith('#'))! : 'Kf5') }, signal());
  assert.equal(result.runs.length, 4); assert.equal(result.accepted, false);
  assert.ok(result.gains[0]!.gain > 0); assert.equal(result.gains[1]!.gain, 0);
  assert.match(result.reason, /required scenario incident/);
});

test('recovery audits finish every pair while preserving the incident improvement gate', async () => {
  const input = contract(1); input.scenarios[0]!.input.minimumGain = .1;
  input.scenarios.push({ id: 'another', seed: 'another', input: { ...contract(1).scenarios[0]!.input } });
  const model = async () => fixture(ids => ids.includes('e4') ? 'e4' : ids[0]!);
  const ordinary = await compareChessStrategies({ baseline, candidate, contract: input, model }, signal());
  assert.equal(ordinary.runs.length, 2);
  const complete = await compareChessStrategies({ baseline, candidate, contract: input, model, completeAllPairs: true }, signal());
  assert.equal(complete.runs.length, 4); assert.equal(complete.accepted, false); assert.match(complete.reason, /required scenario/);
});

test('one lucky repetition cannot qualify, while consistent gains can and role order alternates', async () => {
  const input = contract(1), first = input.scenarios[0]!;
  first.input.saved.initialFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  input.scenarios = [0, 1, 2].map(index => ({ ...structuredClone(first), id: `repeat${index}`, seed: `sample${index}`,
    input: { ...structuredClone(first.input), sample: { id: 'hidden-position', index, count: 3, minimumMeanGain: .1, minimumImprovedPairs: 2 } } }));
  const run = (wins: number) => compareChessStrategies({ baseline, candidate, contract: input, model: async (revision, _budget, id) =>
    fixture(ids => revision.revision.version === 'candidate' && Number(id.match(/^repeat(\d)/)![1]) < wins ? ids.find(id => id.endsWith('#'))! : 'Kf5') }, signal());
  const lucky = await run(1);
  assert.equal(lucky.accepted, false); assert.ok(lucky.meanGain! > 0); assert.match(lucky.reason, /Repeated/);
  const improved = await run(2); assert.equal(improved.accepted, true);
  assert.deepEqual(improved.runs.map(run => run.role), ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate']);
  const malformed = structuredClone(input); malformed.scenarios[2]!.input.saved.initialFen = DEFAULT_POSITION;
  let called = false;
  await assert.rejects(compareChessStrategies({ baseline, candidate, contract: malformed, model: async () => { called = true; return fixture(ids => ids[0]!); } }, signal()), /differ in history/);
  assert.equal(called, false);
});


test('paired strategy evaluation carries scoped goals across moves without changing the frozen opponent', async () => {
  const { prepareChessRequest } = await import('./preparation.ts');
  const captures: Array<{ run: string; ply: number; id?: string; status?: string }> = [];
  const result = await compareChessStrategies({ baseline, candidate, contract: contract(4), model: async (_revision, _ledger, run) => ({
    version: { id: 'goal-evaluation-fixture', version: '1' },
    prepare: async request => {
      const prepared = prepareChessRequest({ abi: 'chess-preparation/2', guidance: '', experienceIndices: [],
        plans: request.candidates.map(plan => ({ id: plan.id, label: plan.label, expectedBenefit: plan.expectedBenefit })),
        temporaryGoal: { key: 'mate', instruction: 'Seek checkmate', reason: 'Exercise bounded pursuit', evidence: ['current-state'], duration: 3, target: { kind: 'checkmate' } },
      }, request);
      captures.push({ run, ply: request.state.ply, id: prepared.temporaryGoal?.current?.record.id, status: prepared.temporaryGoal?.current?.record.status });
      return prepared;
    },
    decide: fixture(ids => ids[0]!).decide,
  }) }, signal());
  assert.ok(result.runs.every(run => run.status === 'complete'));
  for (const side of ['baseline', 'candidate']) {
    const calls = captures.filter(capture => capture.run.startsWith(`position/${side}/`));
    assert.deepEqual(calls.map(call => call.ply), [0, 1, 2, 3]);
    assert.equal(new Set(calls.map(call => call.id)).size, 1);
    assert.deepEqual(calls.map(call => call.status), ['active', 'active', 'active', 'expired']);
  }
});
