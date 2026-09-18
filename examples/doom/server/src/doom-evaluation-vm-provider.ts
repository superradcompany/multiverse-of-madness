import { contentRevision } from '@multiverse/gameplay-harness/node';
import { checkpoints, collectCheckpointSnapshots } from './checkpoints.ts';
import { createWorld, restoreCheckpoint } from './runtime.ts';
import { vmResourcesSchema, type VmResources } from '../../contracts/src/vm.ts';
import type { DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';

/** Configuration is part of the host evaluation contract, never supplied by a candidate. */
export function microsandboxEvaluationVmPorts(options: { image: string; resources: VmResources }): DoomEvaluationVmPorts {
  const image = options.image, resources = vmResourcesSchema.parse(options.resources);
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Evaluation VM image must be pinned to a manifest digest');
  const labels = (owner: string, runId: string) => ({ 'evaluation-owner': owner, 'evaluation-run': contentRevision('doom-evaluation-run', runId).version });
  return {
    create: (id, owner, runId) => createWorld(id, resources, { image, labels: labels(owner, runId) }),
    destroy: async (id, identity, owner, runId, restoredFrom) => {
      const { Sandbox, SandboxNotFoundError } = await import('microsandbox');
      try {
        const handle = await Sandbox.get(id);
        if (identity && handle.id !== identity) throw new Error('Evaluation VM was replaced; refusing cleanup');
        const config = handle.config(), actual = config.labels as Record<string, string> | undefined;
        const tagged = actual?.app === 'multiverse-of-madness' && Object.entries(labels(owner, runId)).every(([key, value]) => actual[key] === value);
        const restored = restoredFrom !== undefined && config.snapshotParent === restoredFrom && config.manifestDigest === image.split('@')[1];
        // Local numeric catalog IDs are scoped to MSB_HOME. Keep provenance checks even after
        // acknowledgment so switching catalogs cannot turn an ID collision into foreign cleanup.
        if (!tagged && !restored) throw new Error('Evaluation VM has no matching ownership labels or restore provenance');
        await handle.destroy({ force: true, timeoutMs: 10000 });
      } catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error; }
    },
    capture: checkpoints.capture,
    restore: restoreCheckpoint,
    parentSnapshot: async runtime => {
      const { Sandbox } = await import('microsandbox');
      const handle = await Sandbox.get(runtime.id);
      if (handle.id !== runtime.identity) throw new Error('Evaluation fork source was replaced');
      const parent = handle.config().snapshotParent;
      if (parent !== undefined && parent !== null && typeof parent !== 'string') throw new Error('Invalid evaluation snapshot lineage');
      return parent ?? undefined;
    },
    snapshotIdentity: async reference => {
      const { Snapshot } = await import('microsandbox');
      const [group, name] = reference.split(':');
      return (await Snapshot.list()).find(snapshot => snapshot.group === group && snapshot.name === name)?.id;
    },
    collect: async points => {
      if (!points.length) return [];
      const { Snapshot } = await import('microsandbox');
      const inventory = await Snapshot.list();
      for (const point of points) {
        const [group, name] = point.reference.split(':');
        const current = inventory.find(snapshot => snapshot.group === group && snapshot.name === name);
        if (current && point.identity && current.id !== point.identity) throw new Error('Evaluation checkpoint was replaced; refusing cleanup');
      }
      const removed = new Set(await collectCheckpointSnapshots(points.map(point => point.reference), inventory, reference => Snapshot.remove(reference)));
      return points.map(point => point.reference).filter(reference => !removed.has(reference));
    },
  };
}
