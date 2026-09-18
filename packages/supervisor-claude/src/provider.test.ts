import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCodeSupervisor, SupervisorFailure, type ClaudeProposalRecord } from './provider.ts';

const ref = { id: 'test', version: '1' };
const request = { id: 'generation', origin: { activation: { epoch: 0, revision: ref }, context: ref }, current: { revision: ref, policy: {}, prompts: {}, skills: [], executor: ref, model: ref, adapter: ref },
  objective: 'win', capabilities: ['executor' as const], contract: ref, task: 'Generate proposal data', evidence: { observed: 'loss' }, outputSchema: { type: 'object' } };
const limits = { timeoutMs: 1000, maxInputBytes: 10000, maxOutputBytes: 10000, maxCostMicros: 1000000 };

test('Claude proposal provider disables tools and unrelated integrations and records actual serving usage without exposing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-provider-test-')), records: ClaudeProposalRecord[] = [];
  const executable = join(root, 'claude-fixture');
  try {
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
const args=process.argv.slice(2); const assert=require('node:assert/strict');
assert.equal(args[args.indexOf('--tools')+1],'');
assert.equal(args[args.indexOf('--effort')+1],'medium');
for(const flag of ['--safe-mode','--strict-mcp-config','--no-session-persistence','--max-budget-usd','--max-turns']) assert.ok(args.includes(flag));
assert.equal(process.env.TYPESAFE_API_KEY,undefined);
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const data=JSON.parse(input); assert.equal(data.request.evidence.observed,'loss'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({reason:'learn from failure'}),modelUsage:{'claude-fixture':{}},usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:5},total_cost_usd:0.0012}));});`, { mode: 0o700 });
    const provider = await ClaudeCodeSupervisor.open({ executable, effort: 'medium', record: async value => { records.push(value); } });
    const output = await provider.propose(request, limits, new AbortController().signal);
    assert.deepEqual(output.draft, { reason: 'learn from failure' }); assert.deepEqual(output.receipt.servingModels, ['claude-fixture']);
    assert.deepEqual(output.receipt.usage, { inputTokens: 30, outputTokens: 5, costMicros: 1200 });
    assert.deepEqual(records.map(record => record.phase), ['pending', 'settled']);
    assert.equal(records[1]!.receipt.status, 'complete');
    assert.equal(records[1]!.configuration.effort, 'medium');
    await assert.rejects(provider.propose(request, { ...limits, maxInputBytes: 1 }, new AbortController().signal), /input limit/);
    assert.equal(records.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed proposal output is retained as a failure and never silently repaired or retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-provider-failure-')), executable = join(root, 'claude-fixture');
  const records: ClaudeProposalRecord[] = [];
  try {
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'not JSON',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0.0001})));`, { mode: 0o700 });
    const provider = await ClaudeCodeSupervisor.open({ executable, effort: 'medium', record: async value => { records.push(value); } });
    await assert.rejects(provider.propose(request, limits, new AbortController().signal), error => error instanceof SupervisorFailure && error.receipt.status === 'failed');
    assert.equal(records.length, 2); assert.equal(records[1]!.phase, 'settled'); assert.ok(records[1]!.envelope);
    assert.equal(records[1]!.receipt.usage?.costMicros, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed CLI invocation preserves auxiliary-model usage and never returns proposal data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-provider-error-')), executable = join(root, 'claude-fixture');
  const records: ClaudeProposalRecord[] = [];
  try {
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,usage:{input_tokens:0,output_tokens:0},modelUsage:{helper:{inputTokens:2076,outputTokens:14}},total_cost_usd:0.002146}));process.exitCode=1;});`, { mode: 0o700 });
    const provider = await ClaudeCodeSupervisor.open({ executable, effort: 'medium', record: async value => { records.push(value); } });
    await assert.rejects(provider.propose(request, limits, new AbortController().signal), error => {
      assert.ok(error instanceof SupervisorFailure);
      assert.equal(error.receipt.status, 'failed');
      assert.deepEqual(error.receipt.usage, { inputTokens: 2076, outputTokens: 14, costMicros: 2146 });
      return true;
    });
    assert.equal(records.length, 2); assert.equal(records[1]!.draft, undefined); assert.ok(records[1]!.envelope);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit unrestricted Claude runs bypass permissions and omit cost, turn, tool and process caps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-unrestricted-')), executable = join(root, 'fixture');
  try {
    await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture-1');process.exit(0)}
const args=process.argv.slice(2),assert=require('node:assert/strict');assert.ok(args.includes('--dangerously-skip-permissions'));
for(const flag of ['--max-budget-usd','--max-turns','--tools','--safe-mode','--permission-mode']) assert.ok(!args.includes(flag));
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{"ok":true}',usage:{input_tokens:1,output_tokens:1},total_cost_usd:5})));`, { mode: 0o700 });
    const provider = await ClaudeCodeSupervisor.open({ executable, unrestricted: true, record: async () => {} });
    const result = await provider.propose(request, { timeoutMs: 1, maxInputBytes: 1, maxOutputBytes: 1, maxCostMicros: 1 }, new AbortController().signal);
    assert.deepEqual(result.draft, { ok: true }); assert.equal(result.receipt.usage!.costMicros, 5000000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
