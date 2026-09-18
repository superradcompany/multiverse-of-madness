import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { VersionRef } from '@multiverse/gameplay-harness';

export interface DoomLearningBuild { revision: VersionRef; node: string; files: Record<string, string> }
/** Hash the executable dependency graph, excluding presentation/service code and credentials. */
export async function readDoomLearningBuild(): Promise<DoomLearningBuild> {
  const result = await build({ entryPoints: ['apps/server/src/session.ts', 'apps/server/src/doom-learning-models.ts',
    'apps/server/src/doom-vm-evaluations.ts', 'apps/server/src/doom-evaluation-vm-provider.ts',
    'packages/executor-microsandbox/src/executor.ts', 'harness/src/index.ts'],
  bundle: true, write: false, metafile: true, packages: 'external', platform: 'node', format: 'esm', outdir: 'virtual-learning-build', logLevel: 'silent' });
  const core = (await readdir('harness/dist', { recursive: true })).filter(file => file.endsWith('.js')).map(file => join('harness/dist', file));
  const paths = [...new Set([...Object.keys(result.metafile.inputs), ...core, 'assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'dist/bridge.mjs', 'package-lock.json'])].sort();
  const files = Object.fromEntries(await Promise.all(paths.map(async file => [file, hash(await readFile(file))])));
  const data = { node: process.version, files }; return { ...data, revision: contentRevision('doom-host-build', data) };
}
export async function retainDoomLearningBuild(directory: string, expected: DoomLearningBuild): Promise<void> {
  for (const [file, digest] of Object.entries(expected.files)) {
    const bytes = await readFile(file);
    if (hash(bytes) !== digest) throw new Error('Gameplay source changed after server startup; restart before enabling learning');
    const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 });
  }
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
