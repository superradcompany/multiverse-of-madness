import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { ExecutableStore, JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomEngine } from '../../packages/game-bridge/src/engine.ts';
import { DoomLearningModels, doomLearningArtifact } from '../../apps/server/src/doom-learning-models.ts';
import { Session } from '../../apps/server/src/session.ts';
import { decisionStatistics } from '../../apps/server/src/decision-context.ts';

// Two live API calls over local WASM observations. No game VM, activation or gameplay-quality claim.
const root = resolve(`artifacts/doom-jev-revisions/${new Date().toISOString().replaceAll(':', '-')}`);
const save = <T>(name: string, value: T) => new JsonFileStore(join(root, name), value => value as T).save(value);
const hashes = Object.fromEntries(await Promise.all(['apps/server/src/jev.ts', 'apps/server/src/jev-learning.ts',
  'apps/server/src/doom-learning-models.ts', 'apps/server/src/decision-context.ts', 'package-lock.json',
  'assets/wasmdoom.wasm', 'assets/freedoom1.wad', import.meta.filename].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const budget = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { modelCalls: 2, simulation: 0 } }, value => save('budget.json', value));
let calls = 0;
const client = new TypeSafeClient({ timeout: 10000, retry: { maxRetries: 0 }, fetch: async (url, init) => {
  const index = ++calls;
  if (typeof init?.body !== 'string') throw new Error('Expected the TypeSafe JSON request body');
  // Persist only the credential-free body; never transport headers or configuration.
  await save(`request-${index}.json`, JSON.parse(init.body));
  const response = await fetch(url, init);
  await save(`response-${index}.json`, { status: response.status, body: await response.clone().json() });
  return response;
} });
const models = new DoomLearningModels({ adapter: { id: 'local-wasm-packet-check', version: '1' },
  builtinExecutor: { id: 'doom-host-packet-check', version: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') },
  executables: new ExecutableStore(join(root, 'unused-sources')), profile: 'game-aware', client,
  executable: () => { throw new Error('Source execution is outside this qualification'); } });
const policy = new Session({ decide: async () => { throw new Error('No session decisions'); } }).learningPolicy();
const { revision: _baseline, ...fields } = models.baseline(policy);
const artifact = doomLearningArtifact({ ...fields,
  prompts: { action: 'Prefer useful open movement over repeating a blocked action.', plan: 'Prefer reachable unexplored waypoints when no visible threat needs attention.', priority: 'Use current health and measured route progress to set urgency.' },
  skills: [{ id: 'observed-progress', instructions: 'Treat failures as local evidence. Do not assume a nearby enemy is visible through a wall.' }] });
await models.verify(artifact);
const state = (await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state();
await save('manifest.json', { hashes, artifact, state, limits: { modelCalls: 2, timeoutMs: 10000, retries: 0 },
  limitations: ['Local WASM observation, no game VM execution.', 'Two API integration checks, not calibration or stronger gameplay.', 'No active user session, guide, model or revision was changed.'] });
try {
  for (const mode of ['actions', 'plans'] as const) {
    const result = await budget.run({ owner: mode, operation: 'live-jev-learning-packet', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
      const decision = await models.model(artifact).decide(state, 'Survive and explore toward the exit.', [], new AbortController().signal, [], 35,
        { policy, stats: decisionStatistics(state), planTicks: mode === 'plans' ? 210 : undefined,
          skills: [{ id: 'user-guide-check', name: 'Avoid waste', instructions: 'Avoid wasting ammunition.', enabled: true }] });
      return { value: decision, usage: { modelCalls: 1, inputTokens: decision.usage!.inputTokens, outputTokens: decision.usage!.outputTokens } };
    });
    await save(`decision-${mode}.json`, result);
    assert.equal(Boolean(result.plans), mode === 'plans');
    assert.equal(result.evidence!.objective, 'Survive and explore toward the exit.');
    assert.equal(result.evidence!.skills![0]!.instructions, 'Avoid wasting ammunition.');
  }
  await budget.join();
  await save('result.json', { status: 'passed', modelCalls: calls, inputTokens: budget.used('inputTokens'), outputTokens: budget.used('outputTokens') });
  console.log(JSON.stringify({ root, status: 'passed', modelCalls: calls, inputTokens: budget.used('inputTokens'), outputTokens: budget.used('outputTokens') }));
} catch (error) {
  await budget.join(); await save('result.json', { status: 'failed', modelCalls: calls, error: error instanceof Error ? error.message : String(error) });
  throw error;
}
