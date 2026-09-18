import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedConfig } from './isolation.ts';
const limits = { timeoutMs: 1000, cpus: 1, memoryMiB: 256, maxInputBytes: 4096, maxOutputBytes: 4096 };
const config = () => ({ network: { enabled: false, ports: [] }, mounts: [], patches: [], resources: { cpus: 1, maxCpus: 1, memoryMib: 256, maxMemoryMib: 256 } });
test('resolved policy cannot silently add host mounts, networking or different evaluation resources', () => {
  assertIsolatedConfig(config(), limits);
  for (const patch of [{ network: { enabled: true, ports: [] } }, { network: { enabled: false, ports: [8080] } }, { mounts: [{}] }, { patches: [{}] }, { resources: { ...config().resources, cpus: 2 } }, { resources: { ...config().resources, maxMemoryMib: 512 } }]) assert.throws(() => assertIsolatedConfig({ ...config(), ...patch }, limits));
});
