import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { DoomEvaluationProcess } from './doom-evaluation-process.ts';
import { doomLearningArtifact } from './doom-learning-models.ts';
import type { DoomLearningManifest } from './doom-learning-manifest.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';
import { defaultVmSettings } from '../../contracts/src/vm.ts';

test('evaluation worker exchanges requests, rejects stale context without creating VMs, and closes cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-worker-'));
  const version = { id: 'fixture', version: '1' };
  const initial = doomLearningArtifact({ adapter: version, executor: version, model: { id: 'typesafe', version: 'jev-latest' },
    prompts: {}, skills: [], policy: new Session({ decide: async () => decision }).learningPolicy() });
  const fields: Omit<DoomLearningManifest, 'revision'> = {
    version: 1, build: { revision: version, node: process.version, files: {} }, profile: 'game-aware',
    image: 'docker.io/library/node@sha256:' + 'a'.repeat(64), resources: defaultVmSettings.defaults, initial,
    contract: { id: 'worker-fixture', evaluator: version, scenarios: [{ id: 'first', seed: 'fixture', input: { setup: [] } }],
      budget: { simulationUnit: 'doom-ticks', limits: { simulation: 1, modelCalls: 0 } }, maxRunMs: 1000,
      acceptance: { metric: 'score', direction: 'maximize', minimumMeanGain: 1, maximumCaseRegression: 0 } },
    generationBudget: { simulationUnit: 'doom-ticks', limits: { supervisorCalls: 1, costMicros: 1 } },
    liveBudget: { simulationUnit: 'doom-ticks', limits: { modelCalls: 1, executorCalls: 1 } },
    proposalLimits: { maxInputBytes: 1000, maxOutputBytes: 1000, timeoutMs: 1000, maxCostMicros: 1 },
    executorLimits: { maxInputBytes: 1000, maxOutputBytes: 1000, timeoutMs: 1000, cpus: 1, memoryMiB: 256 },
  };
  const manifest = { ...fields, revision: contentRevision('doom-learning-service', fields) };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const worker = new DoomEvaluationProcess(directory, manifest, () => ({ revision: version, value: { objective: 'survive', skills: [], overrides: {} } }));
  try {
    await worker.recover(); await worker.recover();
    const request = { proposalId: randomUUID(), baseline: initial, candidate: initial, contract: worker.version, context: { ...version, version: 'stale' } };
    await assert.rejects(worker.qualify(request, new AbortController().signal), /context changed/);
    const mutable = structuredClone(request);
    await writeFile(join(directory, 'session.json'), JSON.stringify({ version: 1, view: { mainId: 'fixture' }, worlds: [] }));
    const cleanup = worker.collectArchives(directory);
    const frozen = worker.qualify(mutable, new AbortController().signal);
    mutable.context = version;
    await assert.rejects(frozen, /context changed/, 'queued worker requests retain the originally supplied context during maintenance');
    await cleanup;
    await writeFile(join(directory, 'session.json'), 'invalid');
    const failedCleanup = assert.rejects(worker.collectArchives(directory));
    await assert.rejects(worker.qualify(request, new AbortController().signal), /context changed/,
      'an archive cleanup failure does not fail the next comparison');
    await failedCleanup;
    await assert.rejects(worker.qualify(request, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
    const current = { ...request, context: version };
    await assert.rejects(worker.qualify(current, new AbortController().signal, undefined, undefined,
      { catalog: { id: 'wrong', version: 'stale' }, scenarioIds: ['opening'], reason: 'Check IPC practice validation' }), /Invalid or stale/);
    await assert.rejects(worker.qualify(current, new AbortController().signal,
      { reference: 'invalid', identity: 'fixture', state: { id: 'doom-game-state', version: 'sha256:' + 'a'.repeat(64) } }), /reference|Invalid|pattern/);
    await worker.recover();
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
