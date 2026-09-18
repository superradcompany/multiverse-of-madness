import { mkdir, writeFile, readFile, link, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { VersionRef } from '../contracts.ts';
import { canonicalJson } from '../policy.ts';
import { maxExecutableBytes, validateExecutableSource, type ExecutableArtifact, type ExecutableSource } from '../executable.ts';
import { contentRevision } from './revision.ts';

export function executableArtifact(source: ExecutableSource): ExecutableArtifact {
  validateExecutableSource(source);
  source = JSON.parse(canonicalJson(source)) as ExecutableSource;
  return { revision: contentRevision('learning-executor', source), source };
}
export function verifyExecutableArtifact(artifact: ExecutableArtifact): void {
  canonicalJson(artifact);
  if (!artifact || Object.keys(artifact).sort().join() !== 'revision,source'
    || canonicalJson(executableArtifact(artifact.source).revision) !== canonicalJson(artifact.revision)) throw new Error('Executable artifact identity mismatch');
}

/** Content-addressed source storage. Never imports, evaluates or builds candidate code on the host. */
export class ExecutableStore {
  constructor(private readonly directory: string) {}
  async put(source: ExecutableSource): Promise<ExecutableArtifact> {
    const artifact = executableArtifact(source);
    await mkdir(this.directory, { recursive: true });
    const path = this.path(artifact.revision), temporary = join(this.directory, `.publish-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, canonicalJson(artifact), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      // A collision or damaged existing artifact must never be silently overwritten.
      return await this.get(artifact.revision);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async get(revision: VersionRef): Promise<ExecutableArtifact> {
    const path = this.path(revision);
    if ((await stat(path)).size > maxExecutableBytes + 512) throw new Error('Stored executable exceeds size limit');
    const artifact = JSON.parse(await readFile(path, 'utf8')) as ExecutableArtifact;
    verifyExecutableArtifact(artifact);
    if (canonicalJson(artifact.revision) !== canonicalJson(revision)) throw new Error('Stored executable does not match requested identity');
    return artifact;
  }
  private path(revision: VersionRef): string {
    if (!revision || revision.id !== 'learning-executor' || !/^sha256:[a-f0-9]{64}$/.test(revision.version)) throw new Error('Invalid executable identity');
    return join(this.directory, `${revision.version.slice(7)}.json`);
  }
}
