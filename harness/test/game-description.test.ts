import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGameDescription, type GameDescription } from '../src/game-description.ts';
const description = (): GameDescription => ({
  format: 1, adapter: { id: 'test', version: '1' }, name: 'Existing game',
  observations: [
    { path: '/tick', type: 'number', meaning: 'simulation tick', availability: 'always' },
    { path: '/choices', type: 'array', meaning: 'legal actions', availability: 'always' },
  ],
  controls: [{ id: 'act', meaning: 'apply action', fields: [{ path: '/action', type: 'string', meaning: 'a legal choice', availability: 'always' }], legalChoices: '/choices', preconditions: 'ongoing', effects: 'advances game' }],
  timing: { unit: 'seconds', sequence: '/tick', commandDuration: 'one tick', waiting: 'paused' },
  planning: { payload: [{ path: '/action', type: 'string', meaning: 'a legal choice', availability: 'always' }], execution: 'one command', validation: 'host rejects illegal actions' },
  outcomes: { success: 'win', failure: 'loss', metrics: [{ id: 'score', meaning: 'game score', direction: 'higher' }] },
  capabilities: { observations: 'structured', exactFork: false, checkpoint: false, restore: false, detached: false, render: true }, limitations: ['No exact forks.'],
});
test('portable description binds to actual mechanics and capabilities without requiring exact forks', () => {
  const value = description();
  validateGameDescription(value, { adapter: value.adapter, capabilities: value.capabilities });
  assert.throws(() => validateGameDescription(value, { adapter: { ...value.adapter, version: '2' }, capabilities: value.capabilities }), /does not match/);
  assert.throws(() => validateGameDescription(value, { adapter: value.adapter, capabilities: { ...value.capabilities, exactFork: true } }), /does not match/);
});
test('invalid references, duplicate identifiers and malformed descriptions cannot reach the supervisor', () => {
  const cases: Array<(value: GameDescription) => void> = [
    value => { value.controls[0]!.legalChoices = '/unavailable'; },
    value => { value.controls[0]!.legalChoices = '/tick'; },
    value => { value.timing.sequence = '/choices'; },
    value => { value.observations.push(value.observations[0]!); },
    value => { value.controls.push(value.controls[0]!); },
    value => { value.outcomes.metrics.push(value.outcomes.metrics[0]!); },
    value => { value.observations[0]!.path = '/invalid~escape'; },
    value => { value.planning.validation = ''; },
  ];
  for (const mutate of cases) { const value = description(); mutate(value); assert.throws(() => validateGameDescription(value)); }
  assert.throws(() => validateGameDescription({ ...description(), privateAcceptanceCases: [] }), /Unexpected/);
  let read = false;
  assert.throws(() => validateGameDescription({ ...description(), get name() { read = true; return 'unsafe'; } }));
  assert.equal(read, false);
});
