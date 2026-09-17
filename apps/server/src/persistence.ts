import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionCheckpoint } from './session.ts';

export class SessionStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<SessionCheckpoint | undefined> {
    try {
      const result = JSON.parse(await readFile(this.path, 'utf8'));
      if (result.version !== 1 || !Array.isArray(result.worlds) || typeof result.view?.mainId !== 'string') throw new Error('Unsupported or invalid session file');
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  save(checkpoint: SessionCheckpoint): Promise<void> {
    const body = JSON.stringify(checkpoint);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, body, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    return this.writes;
  }
  async flush() { await this.writes; }
}
