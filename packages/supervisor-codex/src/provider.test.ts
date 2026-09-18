import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCliSupervisor, type CodexProposalRecord } from './provider.ts';
import { SupervisorFailure } from '../../supervisor-claude/src/provider.ts';
const ref = { id: 'test', version: '1' };
const request = { id: 'generation', origin: { activation: { epoch: 0, revision: ref }, context: ref }, current: { revision: ref, policy: {}, prompts: {}, skills: [], executor: ref, model: ref, adapter: ref },
  objective: 'win', capabilities: ['executor' as const], contract: ref, task: 'Generate proposal data', evidence: {}, outputSchema: { type: 'object' } };
const limits = { timeoutMs: 1, maxInputBytes: 1, maxOutputBytes: 1, maxCostMicros: 1 };

test('Codex bypasses permissions without caps and records tokens without inventing dollar cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-provider-test-')), executable = join(root, 'fixture');
  const records: CodexProposalRecord[] = [];
  try {
    await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
const args=process.argv.slice(2), assert=require('node:assert/strict');
assert.equal(args[0],'exec'); assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
assert.ok(args.includes('--ephemeral')); assert.ok(args.includes('--json')); assert.equal(args.at(-1),'-');
for(const flag of ['--max-budget-usd','--max-turns','--sandbox']) assert.ok(!args.includes(flag));
assert.equal(process.env.TYPESAFE_API_KEY,undefined);
process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reason:'test'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:7,output_tokens:3}}));});`, { mode: 0o700 });
    const provider = await CodexCliSupervisor.open({ executable, record: async record => { records.push(record); } });
    const result = await provider.propose(request, limits, new AbortController().signal);
    assert.deepEqual(result.draft, { reason: 'test' }); assert.equal(result.receipt.status, 'complete');
    assert.deepEqual(result.receipt.usage, { inputTokens: 12, outputTokens: 3, cachedInputTokens: 7 }); assert.deepEqual(result.receipt.servingModels, []);
    assert.deepEqual(records[1]!.tokenUsage, { inputTokens: 12, outputTokens: 3 });
    assert.equal(records[1]!.configuration.permissions, 'bypass');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex failures and malformed final answers retain receipts without publishing proposal data', async () => {
  for (const output of ['not JSON', 'failed']) {
    const root = await mkdtemp(join(tmpdir(), 'codex-provider-failure-')), executable = join(root, 'fixture');
    const records: CodexProposalRecord[] = [];
    try {
      await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(output)});
console.log(JSON.stringify({type:${JSON.stringify(output === 'failed' ? 'turn.failed' : 'turn.completed')}}));});`, { mode: 0o700 });
      const provider = await CodexCliSupervisor.open({ executable, record: async record => { records.push(record); } });
      await assert.rejects(provider.propose(request, limits, new AbortController().signal), error => error instanceof SupervisorFailure && error.receipt.status === 'failed');
      assert.equal(records[1]!.phase, 'settled'); assert.ok(records[1]!.events);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
