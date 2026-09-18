/** One indexed artifact; several entries may refer to the same content identity. */
export interface DependencyArtifact<T> {
  key: string;
  identities: readonly string[];
  dependencies: readonly string[];
  value: T;
}

/**
 * Delete requested leaves, keeping ancestors needed by any indexed artifact.
 * Missing keys count as already removed. Cycles and retained children stay queued.
 * The storage adapter must still enforce its child/reference guard at deletion:
 * an inventory read cannot exclude another process creating a child afterwards.
 */
export async function collectLeafArtifacts<T>(
  requested: readonly string[],
  inventory: readonly DependencyArtifact<T>[],
  remove: (artifact: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<string[]> {
  const existing = [...inventory];
  const keys = new Set<string>();
  for (const artifact of existing) {
    if (!artifact.key || keys.has(artifact.key)) throw new Error('Artifact inventory requires unique nonempty keys');
    if (!artifact.identities.length || artifact.identities.some(id => !id)) throw new Error(`Missing artifact identity: ${artifact.key}`);
    keys.add(artifact.key);
  }
  const pending = new Set(requested), removed: string[] = [];
  let progressed = true;
  while (progressed && !signal?.aborted) {
    progressed = false;
    for (const key of pending) {
      if (signal?.aborted) break;
      const artifact = existing.find(item => item.key === key);
      if (artifact) {
        if (existing.some(child => child.dependencies.some(parent => artifact.identities.includes(parent)))) continue;
        await remove(artifact.value);
        existing.splice(existing.indexOf(artifact), 1);
      }
      removed.push(key); pending.delete(key); progressed = true;
    }
  }
  return removed;
}
