import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemOneRequest, TypeSafeClient } from '@typesafe-ai/sdk';
import { ExecutableStore } from '@multiverse/gameplay-harness/node';
import { DoomEngine } from '../../bridge/src/engine.ts';
import { DoomLearningModels, doomLearningArtifact, type DoomLearningFields } from './doom-learning-models.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';
import { Jev, type DecisionMaker } from './jev.ts';
import { decisionStatistics } from './decision-context.ts';
import { initialStats } from './run-stats.ts';
import { jevGuidance } from './jev-learning.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'doom-models-'));
  const requests: SystemOneRequest[] = [], executed: unknown[] = [];
  const client = { systemOne: async (body: SystemOneRequest) => {
    requests.push(structuredClone(body));
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      assert.equal(question.type, 'choice');
      const ids = Object.keys(question.criteria!), choice = ids[0]!;
      return [key, { choice, confidence: .8, probabilities: Object.fromEntries(ids.map(id => [id, Number(id === choice)])) }];
    }));
    return { model: 'jev-test-actual', answers, usage: { input_tokens: 100, output_tokens: 12 } };
  } } as unknown as Pick<TypeSafeClient, 'systemOne'>;
  const executables = new ExecutableStore(directory);
  const options = { adapter: { id: 'test-adapter', version: '1' }, builtinExecutor: { id: 'test-built-in', version: '1' },
    profile: 'game-aware' as const, executables, client,
    executable: (artifact: unknown) => { executed.push(artifact); return { decide: async () => structuredClone(decision) }; } };
  const models = new DoomLearningModels(options);
  const baseline = models.baseline(new Session({ decide: async () => decision }).learningPolicy());
  const state = (await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state();
  return { models, baseline, requests, client, state, options, executed, executables,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('adopting the built-in Jev artifact preserves baseline requests and records the actual serving model', async () => {
  const f = await fixture();
  try {
    await f.models.verify(f.baseline);
    for (const planTicks of [undefined, 210]) {
      const args: Parameters<DecisionMaker['decide']> = [f.state, 'Explore safely', [], new AbortController().signal, [], 35, { planTicks }];
      await new Jev('game-aware', f.client).decide(...args);
      const result = await f.models.model(f.baseline).decide(...args);
      const [before, after] = f.requests.splice(0);
      const { model, ...request } = after!;
      assert.equal(model, 'jev-latest'); assert.deepEqual(request, before);
      assert.equal(result.model, 'jev-test-actual'); assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 12 });
    }
  } finally { await f.cleanup(); }
});

test('revision prompts and skills reach each applicable Jev question while guide, stats, feasible candidates and user skills remain intact', async () => {
  const f = await fixture();
  try {
    const { revision: _, ...fields } = f.baseline;
    const candidate = doomLearningArtifact({ ...fields, model: { id: 'typesafe', version: 'jev-1.13.0' },
      prompts: { action: 'Prefer unused open movement.', plan: 'Prefer unexplored waypoints.', priority: 'Check resource urgency.' },
      skills: [{ id: 'avoid-loops', instructions: 'Use measured progress when revisiting a location.' }] });
    await f.models.verify(candidate);
    const model = f.models.model(candidate);
    candidate.prompts.action = 'MUTATED AFTER CONSTRUCTION';
    candidate.skills[0]!.instructions = 'MUTATED SKILL';
    const stats = initialStats(f.state); stats.kills = 9; stats.damage = 25;
    const skills = [{ id: 'user', name: 'My tactic', instructions: 'Collect health first.', enabled: true },
      { id: 'disabled', name: 'Off', instructions: 'SHOULD NOT APPEAR', enabled: false }];
    for (const planTicks of [undefined, 210]) {
      const context = { stats: decisionStatistics(f.state, stats), skills, planTicks };
      await new Jev('game-aware', f.client).decide(f.state, 'Avoid combat', [], new AbortController().signal, [], 35, context);
      const result = await model.decide(f.state, 'Avoid combat', [], new AbortController().signal, [], 35, context);
      const [before, after] = f.requests.splice(0);
      assert.equal(after!.model, 'jev-1.13.0');
      const { learning, ...state } = after!.state as Record<string, unknown>;
      assert.deepEqual(state, before!.state);
      assert.deepEqual(learning, { skills: [{ id: 'avoid-loops', instructions: 'Use measured progress when revisiting a location.' }] });
      assert.equal(result.evidence?.objective, 'Avoid combat'); assert.equal(result.evidence?.stats.route.kills, 9);
      assert.deepEqual(result.evidence?.skills, [{ id: 'user', name: 'My tactic', instructions: 'Collect health first.' }]);
      for (const [slot, question] of Object.entries(after!.questions)) {
        assert.deepEqual(question.criteria, before!.questions[slot]!.criteria);
        const instructions = question.instructions as Record<string, unknown>;
        assert.equal(instructions.learned, slot === 'action' ? 'Prefer unused open movement.' : slot === 'plan' ? 'Prefer unexplored waypoints.' : 'Check resource urgency.');
        assert.match(String(instructions.precedence), /user guide and enabled user `skills` take precedence/);
      }
      assert.doesNotMatch(JSON.stringify(after), /MUTATED|SHOULD NOT APPEAR/);
    }
    assert.throws(() => f.models.model(candidate), /must be verified/);
  } finally { await f.cleanup(); }
});

test('artifact verification refuses tampering, unsupported ABIs and unbounded or unconsumed learned guidance', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.models.model(f.baseline), /must be verified/);
    await f.models.verify(f.baseline);
    await assert.rejects(f.models.verify({ ...f.baseline, prompts: { action: 'altered without a new digest' } }), /content mismatch/);
    const { revision: _, ...data } = f.baseline;
    const patches: Partial<DoomLearningFields>[] = [
      { prompts: { typo: 'Never silently ignore this' } }, { adapter: { id: 'other', version: '1' } },
      { model: { id: 'arbitrary-provider', version: '1' } }, { model: { id: 'typesafe', version: '../../model' } },
      { skills: [{ id: 'duplicate', instructions: 'a' }, { id: 'duplicate', instructions: 'b' }] },
      { prompts: { action: 'x'.repeat(1024), plan: 'x'.repeat(1024), priority: 'x'.repeat(1024) } },
      { executor: { id: 'unknown-host-module', version: '1' } },
    ];
    for (const patch of patches) await assert.rejects(f.models.verify(doomLearningArtifact({ ...data, ...patch })));
    assert.throws(() => jevGuidance({ prompts: {}, skills: [{ id: 'x', instructions: '界'.repeat(1000) }] }), /2048-byte/);
    assert.deepEqual(f.executed, []);
  } finally { await f.cleanup(); }
});

test('stored TypeScript is dispatched only through the isolated-model factory and cannot impersonate built-in Jev', async () => {
  const f = await fixture();
  try {
    const source = await f.executables.put({ format: 1, runtime: 'node-typescript', entrypoint: 'main.ts', files: {
      'main.ts': 'throw new Error("Candidate code must never run on the host"); export default input => input;',
    } });
    const { revision: _, ...fields } = f.baseline;
    const candidate = doomLearningArtifact({ ...fields, executor: source.revision, model: { id: 'isolated-doom-ranking', version: '1' } });
    await f.models.verify(candidate); f.models.model(candidate);
    assert.deepEqual(f.executed, [candidate]); assert.deepEqual(f.requests, []);
    await assert.rejects(f.models.verify(doomLearningArtifact({ ...fields, executor: source.revision })), /model ABI/);
    await assert.rejects(f.models.verify(doomLearningArtifact({ ...fields, model: candidate.model })), /built-in Doom model/);
    await assert.rejects(f.models.verify(doomLearningArtifact({ ...fields, executor: { ...source.revision, version: `sha256:${'0'.repeat(64)}` }, model: candidate.model })), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('a guide-only revision reaches every judgment and can be replaced or cleared without rewriting the user objective', async () => {
  const f = await fixture();
  try {
    const { revision: _, ...fields } = f.baseline;
    const guide = 'After an obstructed target, choose a different reachable approach. Preserve health while finding the exit.';
    const revision = doomLearningArtifact({ ...fields, prompts: { guide } });
    await f.models.verify(revision);
    for (const profile of ['game-aware', 'baseline'] as const) {
      // Both game-aware decisions and the legacy telemetry path must consume the guide.
      const model = profile === 'game-aware' ? f.models.model(revision) : new Jev('baseline', f.client, { model: revision.model.version, guidance: jevGuidance(revision) });
      for (const planTicks of [undefined, 210]) {
        const result = await model.decide(f.state, 'Reach the exit without firing', [], new AbortController().signal, [], 35, { planTicks });
        const request = f.requests.pop()!;
        assert.deepEqual((request.state as any).learning, { guide });
        assert.equal(result.evidence?.objective, 'Reach the exit without firing'); assert.equal(result.evidence?.workingGuide, guide);
        for (const question of Object.values(request.questions)) {
          const instructions = question.instructions as Record<string, unknown>;
          assert.match(String(instructions.precedence), /learning.guide/);
          assert.match(String(instructions.precedence), /user guide and enabled user `skills` take precedence/);
        }
      }
    }
    const replacement = doomLearningArtifact({ ...fields, prompts: { guide: 'Use nearby cover when health is low.' } });
    assert.notDeepEqual(replacement.revision, revision.revision);
    await f.models.verify(replacement); await f.models.model(replacement).decide(f.state, 'Reach the exit', [], new AbortController().signal);
    assert.deepEqual((f.requests.pop()!.state as any).learning, { guide: replacement.prompts.guide });
    assert.equal(revision.prompts.guide, guide);
    const cleared = doomLearningArtifact({ ...fields, prompts: { guide: '' } }); await f.models.verify(cleared);
    const result = await f.models.model(cleared).decide(f.state, 'Reach the exit', [], new AbortController().signal);
    assert.equal((f.requests.pop()!.state as any).learning, undefined); assert.equal(result.evidence?.workingGuide, '');
    await assert.rejects(f.models.verify(doomLearningArtifact({ ...fields, prompts: { guide: 'x'.repeat(1025) } })));
  } finally { await f.cleanup(); }
});
