/** Offline only: reads saved executor journals, never starts a server, VM or model call. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeExecutorPerformance } from '../packages/executor-microsandbox/src/performance.ts';

const { values, positionals } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } }, allowPositionals: true });
const usage = 'Usage: node --import tsx scripts/analyze-executor-performance.ts [--from ISO --to ISO] journal.json [journal.json ...]';
if (!positionals.length || (values.from === undefined) !== (values.to === undefined)) throw new Error(usage);
function timestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`Expected an ISO timestamp with timezone. ${usage}`);
  return Date.parse(value);
}
const window = values.from !== undefined && values.to !== undefined ? { from: timestamp(values.from), to: timestamp(values.to) } : undefined;
const reports = [];
for (const path of positionals) {
  const source = resolve(path);
  const input: unknown = JSON.parse(await readFile(source, 'utf8'));
  reports.push({ source, ...analyzeExecutorPerformance(input, window) });
}
process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
