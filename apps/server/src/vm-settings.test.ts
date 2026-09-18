import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VmSettingsStore, assertVmBudget, resourcesFromConfig } from './vm-settings.ts';
import { defaultVmSettings, vmResourcesSchema } from '../../../packages/contracts/src/vm.ts';

test('VM defaults persist independently of game restart and validate boot ceilings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mom-vms-'));
  try {
    const path = join(directory, 'settings.json'), store = new VmSettingsStore(path); await store.open();
    assert.deepEqual(store.settings, defaultVmSettings);
    const settings = { defaults: { ...defaultVmSettings.defaults, cpus: 2, maxCpus: 4 }, budget: { cpus: 12, memory: 12288 } };
    await store.update(settings);
    const restored = new VmSettingsStore(path); await restored.open(); assert.deepEqual(restored.settings, settings);
    await assert.rejects(store.update({ ...settings, budget: { cpus: 1, memory: 0 } }), /budget exceeded/);
    assert.deepEqual(store.settings, settings);
    assert.throws(() => vmResourcesSchema.parse({ ...settings.defaults, cpus: 5 }));
    assert.throws(() => vmResourcesSchema.parse({ ...settings.defaults, memory: 0 }));
    assert.throws(() => vmResourcesSchema.parse({ ...settings.defaults, rootDiskSize: undefined }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('VM budget counts the source in addition to futures and zero removes harness limit', () => {
  const worlds = Array.from({ length: 7 }, () => defaultVmSettings.defaults);
  assert.throws(() => assertVmBudget(worlds, { cpus: 6, memory: 0 }), /including the source/);
  assert.throws(() => assertVmBudget(worlds, { cpus: 0, memory: 6144 }), /budget exceeded/);
  assertVmBudget(worlds, { cpus: 7, memory: 7168 });
  assertVmBudget(worlds, { cpus: 0, memory: 0 });
});
test('VM config projection exposes only resources, rejecting unknown layouts', () => {
  assert.deepEqual(resourcesFromConfig({ resources: { cpus: 1, memoryMib: 1024, maxCpus: 1, maxMemoryMib: 1024 }, image: { Oci: { rootDisk: { sizeMib: 2048 } } }, env: { SECRET: 'must not escape' } }), defaultVmSettings.defaults);
  assert.throws(() => resourcesFromConfig({}));
  assert.deepEqual(resourcesFromConfig({ resources: { cpus: 1, memoryMib: 1024, maxCpus: 1, maxMemoryMib: 1024 }, image: { Oci: { rootDisk: { kind: 'managed' } } } }), { ...defaultVmSettings.defaults, rootDiskSize: undefined });
});
