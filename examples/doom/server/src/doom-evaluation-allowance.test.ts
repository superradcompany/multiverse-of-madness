import test from 'node:test';
import assert from 'node:assert/strict';
import { doomLearningArtifact } from './doom-learning-models.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';
import { withDoomEvaluationAllowance, type DoomEvaluationContract } from './doom-evaluation-allowance.ts';

const policy = new Session({ decide: async () => decision }).learningPolicy();
const artifact = (patch = {}) => doomLearningArtifact({ policy: { ...policy, ...patch }, prompts: {}, skills: [],
  adapter: { id: 'fixture', version: '1' }, executor: { id: 'host', version: '1' }, model: { id: 'typesafe', version: 'jev-latest' } });
const template: DoomEvaluationContract = {
  id: 'fixture', evaluator: { id: 'metric', version: '1' }, allowance: 'complete-futures-v1',
  scenarios: [{ id: 'opening', seed: 'one', input: { setup: [{ ticks: 70, inputs: [] }], minimumSelectedTicks: 210 } }],
  budget: { simulationUnit: 'doom-ticks', limits: { simulation: 4200, modelCalls: 64, executorCalls: 64 } },
  maxRunMs: 180000, acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 },
};
const context = { objective: 'Stay healthy', skills: [], maximumFutures: 7, overrides: {} };

test('long trials receive one shared floor including initialization, without modifying scenarios or acceptance', () => {
  const before = structuredClone(template);
  const current = artifact({ trialTicks: 2100, decisionIntervalMode: 'trial' });
  const result = withDoomEvaluationAllowance(template, current, current, context);
  assert.deepEqual(result.budget.limits, { simulation: 8505, modelCalls: 64, executorCalls: 64 });
  assert.equal(result.maxRunMs, Math.ceil(180000 * 8505 / 4200));
  assert.deepEqual(result.scenarios, template.scenarios); assert.deepEqual(result.acceptance, template.acceptance);
  assert.deepEqual(template, before);
});

test('both policies, user pins, future caps and decision cadence determine the same matched allowance', () => {
  const baseline = artifact(), candidate = artifact({ breadth: 10, trialTicks: 2100, decisionTicks: 35 });
  const result = withDoomEvaluationAllowance(template, baseline, candidate, context);
  assert.equal(result.budget.limits.simulation, 14805);
  assert.equal(result.budget.limits.modelCalls, 414); assert.equal(result.budget.limits.executorCalls, 414);
  assert.deepEqual(withDoomEvaluationAllowance(template, candidate, baseline, context), result);
  const pinned = withDoomEvaluationAllowance(template, baseline, candidate, { ...context,
    maximumFutures: 2, overrides: { trialTicks: 35, decisionTicks: 35 } });
  assert.deepEqual(pinned.budget, template.budget);
  assert.equal(pinned.maxRunMs, template.maxRunMs);
});

test('short trials still have enough parent decisions to meet selected coverage', () => {
  const short = artifact({ breadth: 2, trialTicks: 1, decisionTicks: 1 });
  const result = withDoomEvaluationAllowance(template, short, short, context);
  assert.equal(result.budget.limits.modelCalls, 210);
  assert.equal(result.budget.limits.simulation, 4200);
});

test('historical fixed contracts remain exactly fixed and unknown sizing rules are refused', () => {
  const { allowance: _, ...historical } = template;
  const current = artifact({ trialTicks: 2100 });
  assert.deepEqual(withDoomEvaluationAllowance(historical, current, current, context), historical);
  assert.throws(() => withDoomEvaluationAllowance({ ...template, allowance: 'unknown' as never }, current, current, context), /Unsupported/);
});
