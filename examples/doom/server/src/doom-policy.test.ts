import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from './session.ts';
import { Recordings } from './recordings.ts';
import { Runtime, decision } from '../test-support/fixture-runtime.ts';

const options = { threshold: 0.75, horizon: 7, branches: 2, paceMs: 0 };
const provider = { decide: async () => structuredClone(decision) };

test('Doom decisions, child recordings and saved sessions retain verifiable policy provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doom-policy-'));
  const recordings = new Recordings(directory);
  try {
    await recordings.open();
    const session = new Session(provider, options);
    session.setRecorder((world, frame) => recordings.record(world, frame));
    await session.initialize(new Runtime('root'));
    session.step(); await session.idle();
    assert.equal(session.snapshot().error, undefined);
    const saved = session.checkpoint(), ref = saved.view.decision!.policyRevision!;
    assert.ok(ref.version.startsWith('sha256:'));
    const policy = saved.policies!.find(entry => entry.revision.version === ref.version)!.policy;
    assert.equal(policy.values.trialTicks, 7);
    assert.equal(policy.values.decisionTicks, 35);
    assert.equal(policy.values.breadth, 2);
    await recordings.flush();
    for (const experiment of saved.experiments) {
      const first = await recordings.get(experiment.id, 0);
      const last = await recordings.get(experiment.id, recordings.list().worlds.find(w => w.id === experiment.id)!.frames - 1);
      assert.deepEqual(first.world.policyRevision, ref);
      assert.deepEqual(last.world.policyRevision, ref);
    }
    const restored = new Session(provider, options);
    await restored.restore(JSON.parse(JSON.stringify(saved)), async id => new Runtime(id, saved.worlds.find(w => w.view.id === id)!.view.state));
    assert.deepEqual(restored.checkpoint().policies, saved.policies);
    assert.deepEqual(restored.snapshot().decision?.policyRevision, ref);
    const changed = structuredClone(saved);
    (changed.policies![0]!.policy.values as { breadth: number }).breadth = 9;
    await assert.rejects(new Session(provider, options).restore(changed, async () => assert.fail('must refuse before reconnecting')), /does not match its revision/);
    const missing = structuredClone(saved); missing.policies = [];
    await assert.rejects(new Session(provider, options).restore(missing, async () => assert.fail('must refuse before reconnecting')), /unavailable policy revision/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('edits during a judgment keep the requested trial budget and distinguish routing policy', async () => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const session = new Session({ decide: async () => { entered(); await response; return structuredClone(decision); } }, options);
  await session.initialize(new Runtime('root')); session.step(); await waiting;
  session.setTrialDuration(70); session.setForkThreshold(0.1);
  release(); await session.idle();
  assert.equal(session.snapshot().error, undefined);
  const saved = session.checkpoint(), selected = saved.view.decision!;
  assert.notDeepEqual(selected.policyRevision, selected.routingPolicyRevision);
  const asked = saved.policies!.find(entry => entry.revision.version === selected.policyRevision!.version)!.policy.values;
  const routed = saved.policies!.find(entry => entry.revision.version === selected.routingPolicyRevision!.version)!.policy.values;
  assert.equal(asked.forkThreshold, 0.75); assert.equal(routed.forkThreshold, 0.1);
  assert.equal(asked.trialTicks, 7); assert.equal(routed.trialTicks, 7);
  assert.equal(saved.view.trialDurationTicks, 70);
  assert.ok(saved.worlds.filter(w => w.view.role === 'experiment').every(w => w.view.trial?.total === 7));
});
