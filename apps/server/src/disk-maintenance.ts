import type { DiskCompactionOptions, DiskCompactionResult } from 'microsandbox';

/** Forks and snapshots seal another root layer. Stay well below the runtime's 256-layer bound. */
export const ROOT_LAYER_COMPACTION_THRESHOLD = 64;
export async function maintainRootDisk(sandbox: { compact(options: DiskCompactionOptions): Promise<DiskCompactionResult> }): Promise<void> {
  const plan = await sandbox.compact({ rootDiskOnly: true, dryRun: true });
  if (plan.inputLayers < ROOT_LAYER_COMPACTION_THRESHOLD) return;
  try {
    // The runtime merges sealed layers and switches the disk while preserving
    // guest memory and the writable head. Existing snapshots own their backing.
    await sandbox.compact({ rootDiskOnly: true });
  } catch (error) {
    // Do not retry or fork after a failed disk adoption: the runtime may have
    // paused for recovery. Preserve its diagnostic instead of masking it.
    throw new Error(`Root disk maintenance failed; play stopped before capture: ${error instanceof Error ? error.message : String(error)}`);
  }
}
