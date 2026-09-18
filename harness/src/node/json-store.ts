import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckpointStore } from '../contracts.ts';

/** Serial, atomically published JSON. A failed write poisons this instance. */
export class JsonFileStore<T> implements CheckpointStore<T> {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly decode: (value: unknown) => T) {}
  async load(): Promise<T | undefined> {
    try { return this.decode(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  save(value: T): Promise<void> {
    const body = JSON.stringify(value);
    if (body === undefined) return Promise.reject(new Error('Checkpoint is not JSON serializable'));
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, body, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    return this.writes;
  }
  async flush() { await this.writes; }
}
