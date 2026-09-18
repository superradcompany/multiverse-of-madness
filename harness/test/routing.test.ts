import test from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision } from '../src/routing.ts';
const candidates = [
  { move: 'swap', probability: 0.25 },
  { move: 'slide', probability: 0.5 },
  { move: 'hold', probability: 0.25 },
];
const policy = { threshold: 0.75, breadth: 2 };
const context = { confidence: 0.4, manual: false, stalled: false, retries: 0 };
test('routing preserves stable preferences and rotates retries without mutating candidates', () => {
  const first = routeDecision(candidates, policy, context);
  assert.equal(first.mode, 'uncertain');
  assert.deepEqual(first.trials.map(c => c.move), ['slide', 'swap']);
  const retry = routeDecision(candidates, policy, { ...context, retries: 1 });
  assert.deepEqual(retry.trials.map(c => c.move), ['hold', 'slide']);
  assert.deepEqual(candidates.map(c => c.move), ['swap', 'slide', 'hold']);
  assert.equal(first.trials[0], candidates[1]);
});
test('manual and stalled comparisons override confidence; threshold equality is direct', () => {
  assert.equal(routeDecision(candidates, policy, { ...context, confidence: 0.75 }).mode, 'direct');
  assert.deepEqual(routeDecision(candidates, policy, { ...context, confidence: 1 }).trials, []);
  assert.equal(routeDecision(candidates, policy, { ...context, confidence: 1, stalled: true }).mode, 'stalled');
  assert.equal(routeDecision(candidates, policy, { ...context, confidence: 1, stalled: true, manual: true }).mode, 'manual');
});
test('invalid judgments fail instead of silently bypassing the uncertainty threshold', () => {
  assert.throws(() => routeDecision(candidates, policy, { ...context, confidence: NaN }), /Decision confidence/);
  assert.throws(() => routeDecision([], policy, context), /No eligible/);
  assert.throws(() => routeDecision(candidates, { ...policy, breadth: 0 }, context), /breadth/);
  assert.throws(() => routeDecision([{ probability: Infinity }], policy, context), /Candidate probability/);
});
