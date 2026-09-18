export interface BoundedProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface BoundedProcessResult {
  status: 'complete' | 'failed' | 'cancelled' | 'timeout';
  stdout: string;
  stderr: string;
  outputBytes: number;
  exitCode: number | null;
  error?: string;
}
