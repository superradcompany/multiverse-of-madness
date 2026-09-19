import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@multiverse/gameplay-harness';
import { supervisorExampleHistory } from '../examples/doom/server/src/supervisor-example-history.ts';
import { supervisorTokens } from '../examples/doom/server/src/supervisor-token-usage.ts';

// Read-only archive analysis. Emit aggregates, never prompts, game data or provider output.
const argument = process.argv[2];
if (!argument || process.argv.length !== 3) throw new Error('Usage: node --import tsx scripts/analyze-supervisor-history.ts <learning-directory>');
const root = resolve(argument);
const entries = async (directory: string) => readdir(directory, { withFileTypes: true }).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;
});
const directories = [root, ...(await entries(join(root, 'lineages'))).filter(entry => entry.isDirectory()).map(entry => join(root, 'lineages', entry.name)).sort()];
const archive = createHash('sha256');
const ids = new Set<string>(), elapsed: number[] = [], promptBytes: number[] = [], reductions: number[] = [];
const statuses: Record<string, number> = {};
let inputTokens = 0, outputTokens = 0, unknownTokenCalls = 0, examples = 0, samples = 0, repeats = 0, beforeBytes = 0, afterBytes = 0;
for (const directory of directories) for (const file of (await entries(join(directory, 'provider'))).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!file.isFile() || !file.name.endsWith('.json')) continue;
  const path = join(directory, 'provider', file.name), body = await readFile(path, 'utf8');
  archive.update(relative(root, path)).update('\0').update(body).update('\0');
  const record = JSON.parse(body);
  const receipt = record.receipt;
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id) throw new Error('Provider receipt identity is missing');
  if (ids.has(receipt.id)) throw new Error('Duplicate provider receipt identity; do not sum copied histories');
  ids.add(receipt.id);
  const status = record.phase === 'pending' ? 'pending' : receipt.status;
  if (!['complete', 'failed', 'cancelled', 'timeout', 'pending'].includes(status)) throw new Error('Provider receipt status is invalid');
  statuses[status] = (statuses[status] ?? 0) + 1;
  const tokens = supervisorTokens(record, receipt.id);
  if (tokens) { inputTokens += tokens.inputTokens; outputTokens += tokens.outputTokens; } else unknownTokenCalls++;
  if (status !== 'pending' && typeof receipt.elapsedMs === 'number' && Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0) elapsed.push(receipt.elapsedMs);
  if (Number.isSafeInteger(receipt.inputBytes) && receipt.inputBytes >= 0) promptBytes.push(receipt.inputBytes);
  const envelope = record.request, evidence = envelope?.request?.evidence, example = evidence?.preparationExample;
  if (!example?.state || !Array.isArray(example.history) || evidence.preparationExampleHistory) continue;
  examples++; samples += example.history.length;
  const selection = supervisorExampleHistory(example.state, example.history);
  const removed = selection.sampling.repeatsCurrentState + selection.sampling.repeatsEarlierEntry;
  repeats += removed;
  const before = Buffer.byteLength(canonicalJson(envelope));
  if (removed) {
    example.history = selection.history;
    example.defaultHistoryIndices = selection.history.map((_, index) => index);
    evidence.preparationExampleHistory = selection.sampling;
  }
  const after = Buffer.byteLength(canonicalJson(envelope));
  beforeBytes += before; afterBytes += after; reductions.push(before - after);
}
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
if (![inputTokens, outputTokens, beforeBytes, afterBytes].every(Number.isSafeInteger)) throw new Error('Analysis count overflow');
console.log(JSON.stringify({ archiveSha256: archive.digest('hex'), receipts: ids.size, statuses,
  reported: { inputTokens, outputTokens, knownTokenCalls: ids.size - unknownTokenCalls, unknownTokenCalls,
    elapsedSamples: elapsed.length, inputSizeSamples: promptBytes.length, medianElapsedMs: median(elapsed), medianInputBytes: median(promptBytes) },
  historicalExampleReencoding: { examples, samples, exactRepeats: repeats, beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes,
    savedPercent: beforeBytes ? (beforeBytes - afterBytes) * 100 / beforeBytes : null, medianBytesSaved: median(reductions) },
  limitations: 'Historical receipts, not a current benchmark. Re-encoding changes only sampled history and its index/omission metadata. Original unsampled history lengths are unavailable here. Bytes are not tokens; no new supervisor call, gameplay-quality check, cost estimate or proof of healthy-review suppression was performed.' }, null, 2));
