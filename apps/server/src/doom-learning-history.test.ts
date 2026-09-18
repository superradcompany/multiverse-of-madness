import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RevisionController, canonicalJson, type LearningRevision } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { doomLearningHistory, verifyDoomLearningHistory } from './doom-learning-history.ts';
import { doomLearningBinding, doomLearningProvenance, verifyDoomLearning } from './doom-learning.ts';
import { doomLearningArtifact } from './doom-learning-models.ts';
import type { DoomPolicy } from './doom-policy.ts';
import { Session } from './session.ts';
import { decision } from '../test-support/fixture-runtime.ts';

async function fixture(build: string) {
  const artifact = doomLearningArtifact({ policy: new Session({ decide: async () => decision }).learningPolicy(),
    adapter: { id: 'doom-learning-adapter', version: build }, executor: { id: 'doom-jev-host', version: build },
    model: { id: 'typesafe', version: 'jev-latest' }, prompts: {}, skills: [] });
  const identity = { id: 'doom-supervisor', version: randomUUID() };
  const controller = await RevisionController.create(artifact, { contract: { id: 'test', version: build }, capabilities: ['prompts'], maxLifetimeMs: 10000 }, {
    context: () => identity, boundary: work => work(), verify: async () => {}, compatible: async () => {}, persist: async () => {},
    qualify: async () => { throw new Error('No evaluation expected'); },
  });
  return { artifact, identity, controller, saved: { version: 1 as const, identity, journal: controller.snapshot() } };
}
async function verify(artifact: LearningRevision<DoomPolicy>) {
  const { revision, ...fields } = artifact;
  assert.deepEqual(revision, contentRevision('doom-learning', fields));
}

test('verified historical activations retain their original adapter while current execution uses the new build', async () => {
  const old = await fixture('old'), current = await fixture('new');
  const history = doomLearningHistory([old.saved]), before = canonicalJson(history);
  const resolve = await verifyDoomLearningHistory(history, verify);
  const binding = doomLearningBinding(current.controller, current.identity, artifact => {
    assert.deepEqual(artifact, current.artifact); return { decide: async () => decision };
  }, resolve);
  const reference = doomLearningProvenance(binding, old.controller.active);
  assert.deepEqual(reference.adapter, old.artifact.adapter);
  verifyDoomLearning(binding, reference);
  assert.deepEqual(binding.current().artifact, current.artifact);
  assert.equal(canonicalJson(history), before);
  const returned = binding.resolve(old.controller.active); returned.prompts.plan = 'mutation';
  assert.deepEqual(binding.resolve(old.controller.active), old.artifact);
  assert.throws(() => doomLearningProvenance(binding, old.controller.active, current.artifact), /Incompatible/);
  assert.throws(() => binding.model(old.artifact));
  assert.throws(() => binding.resolve({ ...old.controller.active, epoch: 9 }), /Unknown/);
});

test('history rejects changed envelopes, duplicate identities, invalid chains and failed artifact validation', async () => {
  const old = await fixture('old');
  const changed = doomLearningHistory([old.saved]); changed.lineages[0]!.journal.active.epoch = 1;
  await assert.rejects(verifyDoomLearningHistory(changed, verify), /content mismatch/);
  await assert.rejects(verifyDoomLearningHistory(doomLearningHistory([old.saved, old.saved]), verify), /Duplicate/);
  const invalid = structuredClone(old.saved); invalid.journal.active.epoch = 1;
  await assert.rejects(verifyDoomLearningHistory(doomLearningHistory([invalid]), verify));
  await assert.rejects(verifyDoomLearningHistory(doomLearningHistory([old.saved]), async () => { throw new Error('missing source'); }), /missing source/);
});

test('an unfinished historical evaluation is refused without resuming or rewriting it', async () => {
  const old = await fixture('old');
  const { revision: ignored, ...fields } = old.artifact;
  const corrected = doomLearningArtifact({ ...fields, prompts: { plan: 'Test' } });
  await old.controller.submit({ id: 'pending', candidate: corrected, reason: 'test', expiresAt: Date.now() + 5000 });
  const saved = { ...old.saved, journal: old.controller.snapshot() };
  saved.journal.proposals[0]!.status = 'evaluating';
  let verified = 0;
  await assert.rejects(verifyDoomLearningHistory(doomLearningHistory([saved]), async () => { verified++; }), /Finish or reconcile/);
  assert.equal(verified, 0); assert.equal(saved.journal.proposals[0]!.status, 'evaluating');
});
