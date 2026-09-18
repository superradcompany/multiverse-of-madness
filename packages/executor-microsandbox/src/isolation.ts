import type { ExecutorLimits } from '@multiverse/gameplay-harness';

/** Verify resolved configuration before uploading any candidate source or observation. */
export function assertIsolatedConfig(input: Record<string, unknown>, limits: ExecutorLimits): void {
  const resources = input.resources as Record<string, unknown> | undefined;
  const network = input.network as { enabled?: unknown; ports?: unknown[] } | undefined;
  if (network?.enabled !== false || !Array.isArray(network.ports) || network.ports.length
    || !Array.isArray(input.mounts) || input.mounts.length || !Array.isArray(input.patches) || input.patches.length) throw new Error('Resolved executor configuration contains networking, mounts or patches');
  if (resources?.cpus !== limits.cpus || resources.maxCpus !== limits.cpus || resources.memoryMib !== limits.memoryMiB || resources.maxMemoryMib !== limits.memoryMiB) throw new Error('Resolved executor resources differ from the evaluation limits');
}
