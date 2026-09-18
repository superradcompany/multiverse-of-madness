import type { VersionRef } from './contracts.ts';
import { canonicalJson } from './policy.ts';

/** Source is data until an isolated provider loads it. No host build scripts or host filesystem imports. */
export interface ExecutableSource {
  format: 1;
  runtime: 'node-typescript';
  entrypoint: string;
  files: Record<string, string>;
}
export interface ExecutableArtifact { revision: VersionRef; source: ExecutableSource }
export interface ExecutorLimits {
  /** Deadline includes provisioning/upload/execution; cleanup is joined after it. */
  timeoutMs: number;
  cpus: number;
  memoryMiB: number;
  maxInputBytes: number;
  /** Combined stdout and stderr bound, enforced by the host stream consumer. */
  maxOutputBytes: number;
}
export interface ExecutorReceipt {
  revision: VersionRef;
  provider: VersionRef;
  limits: ExecutorLimits;
  runtime: { id: string; identity: string; image: string };
  startedAt: number;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  status: 'complete' | 'failed' | 'cancelled' | 'timeout';
  error?: string;
}
export interface ExecutorOutput { value: unknown; receipt: ExecutorReceipt }
export interface ExecutableProvider {
  readonly version: VersionRef;
  /** Output is untrusted. The host validates domain actions and measures outcomes independently. */
  execute(artifact: ExecutableArtifact, input: unknown, limits: ExecutorLimits, signal: AbortSignal): Promise<ExecutorOutput>;
}
export const maxExecutableBytes = 1_048_576;

/** Validate a portable source manifest; all files are literal text, never symlinks or host paths. */
export function validateExecutableSource(value: ExecutableSource): void {
  const encoded = canonicalJson(value);
  if (!value || Object.keys(value).sort().join() !== 'entrypoint,files,format,runtime' || value.format !== 1 || value.runtime !== 'node-typescript') throw new Error('Unsupported executable source format');
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Executable source requires files');
  const paths = Object.keys(value.files);
  if (!paths.length || paths.length > 64) throw new Error('Executable source must have 1 to 64 files');
  for (const path of paths) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(ts|json)$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
      || typeof value.files[path] !== 'string') throw new Error('Invalid executable source path or contents');
    if (paths.some(other => other.startsWith(`${path}/`))) throw new Error('Executable file cannot also be a directory');
  }
  if (typeof value.entrypoint !== 'string' || !value.entrypoint.endsWith('.ts') || !Object.hasOwn(value.files, value.entrypoint)) throw new Error('Executable TypeScript entrypoint is missing');
  if (new TextEncoder().encode(encoded).length > maxExecutableBytes) throw new Error('Executable source exceeds size limit');
}
export function validateExecutorLimits(value: ExecutorLimits): void {
  canonicalJson(value);
  if (!value || Object.keys(value).sort().join() !== 'cpus,maxInputBytes,maxOutputBytes,memoryMiB,timeoutMs'
    || Object.values(value).some(n => !Number.isSafeInteger(n))) throw new Error('Invalid executor limits');
  if (value.timeoutMs < 1 || value.timeoutMs > 120_000 || value.cpus < 1 || value.cpus > 4 || value.memoryMiB < 128 || value.memoryMiB > 2048
    || value.maxInputBytes < 1 || value.maxInputBytes > maxExecutableBytes || value.maxOutputBytes < 1 || value.maxOutputBytes > maxExecutableBytes) throw new Error('Executor limits exceed supported bounds');
}
