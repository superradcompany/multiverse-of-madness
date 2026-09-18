import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POSITION } from 'chess.js';
import { BudgetLedger, type EvaluationContract, type LearningRevision } from '@multiverse/gameplay-harness';
import { compareChessHarnesses } from './harness-evaluation.ts';
import { ChessAdapter } from './adapter.ts';
import { defaultChessPolicy } from './policy.ts';
import { ChessRuntimeStore } from './runtime-store.ts';
import type { ChessStrategyScenario } from './strategy-evaluation.ts';
import type { ChessDecisionModel } from './revisions.ts';
import type { ChessPolicy } from './session-types.ts';

const baseline: LearningRevision<ChessPolicy> = { revision: { id: 'strategy', version: 'baseline' }, executor: { id: 'source', version: 'baseline' }, model: { id: 'fixture', version: '1' }, adapter: new ChessAdapter().version,
  policy: defaultChessPolicy, skills: [], prompts: {} };
const candidate = { ...baseline, revision: { id: 'strategy', version: 'candidate' }, executor: { id: 'source', version: 'candidate' } };
const history = ['d4', 'd5', 'c4', 'e6', 'cxd5', 'Qxd5', 'Qa4+', 'Kd8'];
const contract = (): EvaluationContract<ChessStrategyScenario> => ({ id: 'full-harness', evaluator: { id: 'fixture-host', version: '1' },
  scenarios: [{ id: 'observed', seed: 'same', input: { saved: { initialFen: DEFAULT_POSITION, moves: history }, player: 'w', objective: 'win by checkmate', plies: 2 } }],
  budget: { simulationUnit: 'chess-plies', limits: { simulation: 4, modelCalls: 3, executorCalls: 3 } }, maxRunMs: 2000,
  acceptance: { metric: 'value', direction: 'maximize', minimumMeanGain: .1, maximumCaseRegression: 0 } });

// Controlled preferences exercise the real session loop and budgets, not model strength or real VM execution.
test('full harness evaluation accounts for discarded futures, preserves history and fixes the opponent revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-harness-'));
  const decisions: Array<{ role: string; revision: string; side: string }> = [];
  try {
    const report = await compareChessHarnesses({ directory, baseline, candidate, contract: contract(), model: async (artifact, ledger, role): Promise<ChessDecisionModel> => ({
      version: artifact.model,
      prepare: (request, signal) => ledger.run({ owner: role, operation: 'fixture-preparation', reserve: { executorCalls: 1 } }, async () => ({ value: request, usage: { executorCalls: 1 } }), signal),
      decide: async request => {
        assert.deepEqual(request.revision, artifact.revision); decisions.push({ role, revision: artifact.revision.version, side: request.state.turn });
        const first = request.state.turn === 'w' ? 'Qd7+' : request.candidates.some(plan => plan.id === 'Qxd7') ? 'Qxd7' : 'Bb4+';
        return { selected: first, confidence: .2, preferences: request.candidates.map(plan => ({ id: plan.id,
          probability: plan.id === first ? (request.state.turn === 'w' ? .6 : 1) : request.state.turn === 'w' && plan.id === 'Qd1' ? .4 : 0 })), usage: { calls: 0 } };
      },
    }) }, new AbortController().signal);
    assert.equal(report.runs.length, 2); assert.equal(report.accepted, false);
    for (const run of report.runs) {
      assert.equal(run.status, 'complete', run.error); assert.equal(run.metrics!.value, 0);
      assert.deepEqual(run.evidence!.before.moves, history);
      assert.deepEqual(run.evidence!.after.moves.slice(history.length), ['Qd1', 'Bb4+']);
      assert.deepEqual(run.evidence!.harness.attempts, { plies: 4, decisions: 3, forks: 1, rollbacks: 0 });
      assert.equal(run.evidence!.harness.selectedPlies, 2);
      for (const [resource, used] of [['simulation', 4], ['modelCalls', 3], ['executorCalls', 3]] as const) assert.equal(new BudgetLedger(contract().budget, async () => {}, run.budget).used(resource), used);
      const saved = JSON.parse(await readFile(join(directory, 'observed', run.role, 'session/session.json'), 'utf8'));
      assert.ok(saved.worlds.some((world: any) => world.state.moves.slice(history.length).join(' ') === 'Qd7+ Qxd7'));
    }
    assert.ok(decisions.filter(item => item.side === 'b').every(item => item.revision === 'baseline' && item.role.endsWith('/opponent')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime accounting refuses excess input before changing a child board', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-meter-'));
  const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: { simulation: 1 } }, async () => {});
  try {
    const runtime = new ChessRuntimeStore(directory, DEFAULT_POSITION, { run: (id, apply) => ledger.run({ owner: id, operation: 'input', reserve: { simulation: 1 } }, async () => ({ value: await apply(), usage: { simulation: 1 } })) });
    const parent = await runtime.create('parent', new AbortController().signal), [child] = await parent.branch(['child']);
    await child!.step({ san: 'e4' }); const before = await child!.state();
    await assert.rejects(child!.step({ san: 'e5' }), /Budget exhausted/);
    assert.deepEqual(await child!.state(), before); assert.equal((await parent.state()).ply, 0);
    assert.deepEqual(await (await runtime.connect(child!.id, child!.identity, new AbortController().signal)).state(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an opponent-first incident finishes its last trial and scores an equal selected prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-harness-prefix-'));
  const input = contract(); input.scenarios[0]!.input.saved.moves = ['e4'];
  input.budget.limits = { simulation: 6, modelCalls: 6, executorCalls: 6 };
  try {
    const report = await compareChessHarnesses({ directory, baseline, candidate, contract: input, model: async (artifact, ledger, role) => ({
      version: artifact.model,
      prepare: (request, signal) => ledger.run({ owner: role, operation: 'preparation', reserve: { executorCalls: 1 } }, async () => ({ value: request, usage: { executorCalls: 1 } }), signal),
      decide: async request => ({ selected: request.candidates[0]!.id, confidence: .2,
        preferences: request.candidates.map((plan, index) => ({ id: plan.id, probability: index < 2 ? .5 : 0 })), usage: { calls: 0 } }),
    }) }, new AbortController().signal);
    for (const run of report.runs) {
      assert.equal(run.status, 'complete', run.error);
      const evidence = run.evidence!;
      assert.equal(evidence.harness.selectedPlies, 2); assert.equal(evidence.after.ply, 3);
      assert.equal(evidence.harness.committed.ply, 4); assert.equal(evidence.harness.attempts.plies, 5);
      assert.deepEqual(evidence.after.moves, evidence.harness.committed.moves.slice(0, 3));
      assert.equal(evidence.moves.length, 2); assert.equal(evidence.harness.replayLastTick, evidence.harness.committed.ply);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a clean resource stop retains evidence but cannot qualify a shortened comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-harness-short-'));
  const limited = contract(); limited.scenarios[0]!.input.plies = 4;
  limited.acceptance.minimumMeanGain = 0;
  try {
    const report = await compareChessHarnesses({ directory, baseline, candidate, contract: limited, model: async (artifact, ledger, role) => ({
      version: artifact.model,
      prepare: (request, signal) => ledger.run({ owner: role, operation: 'preparation', reserve: { executorCalls: 1 } }, async () => ({ value: request, usage: { executorCalls: 1 } }), signal),
      decide: async request => {
        const selected = request.state.turn === 'w' ? 'Qd1' : request.candidates.some(plan => plan.id === 'Qxd7') ? 'Qxd7' : 'Bb4+';
        return { selected, confidence: .2, preferences: request.candidates.map(plan => ({ id: plan.id,
          probability: plan.id === selected ? (request.state.turn === 'w' ? .6 : 1) : request.state.turn === 'w' && plan.id === 'Qd7+' ? .4 : 0 })), usage: { calls: 0 } };
      },
    }) }, new AbortController().signal);
    assert.ok(report.runs.every(run => run.status === 'complete' && run.evidence!.harness.selectedPlies === 2));
    assert.equal(report.meanGain, 0); assert.equal(report.accepted, false);
    assert.match(report.reason, /required selected-path horizon/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid full-harness allowances and cancellation cannot produce an accepted comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-harness-stop-'));
  let calls = 0;
  try {
    const limited = contract(); limited.budget.limits.simulation = 3;
    const never = async (): Promise<ChessDecisionModel> => { calls++; throw new Error('should not prepare'); };
    await assert.rejects(compareChessHarnesses({ directory, baseline, candidate, contract: limited, model: never }, new AbortController().signal), /allowances/); assert.equal(calls, 0);
    const control = new AbortController();
    const report = await compareChessHarnesses({ directory, baseline, candidate, contract: contract(), model: async artifact => ({ version: artifact.model,
      decide: async () => { calls++; control.abort(new Error('cancelled')); throw control.signal.reason; },
    }) }, control.signal);
    assert.equal(report.accepted, false); assert.ok(report.runs.every(run => run.status !== 'complete'));
    assert.equal(calls, 1); assert.ok(report.runs.every(run => run.budget.entries.every(entry => entry.status !== 'pending')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
