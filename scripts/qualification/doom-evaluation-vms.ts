import '../runtime-env.ts';
import '../build-bridge.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BudgetLedger } from '@multiverse/gameplay-harness';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { DoomEvaluationVms, decodeDoomEvaluationVms } from '../../examples/doom/server/src/doom-evaluation-vms.ts';
import { microsandboxEvaluationVmPorts } from '../../examples/doom/server/src/doom-evaluation-vm-provider.ts';
import type { VmResources } from '../../examples/doom/contracts/src/vm.ts';

const phase = process.argv[2];
if (!phase) {
  const root = resolve('artifacts/doom-evaluation-vms', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(root, { recursive: true });
  const { Image } = await import('microsandbox');
  const image = await Image.get('docker.io/library/node:24-alpine'); assert.ok(image.manifestDigest);
  const files = ['assets/wasmdoom.wasm', 'assets/freedoom1.wad', 'dist/bridge.mjs', 'package-lock.json', 'scripts/qualification/doom-evaluation-vms.ts',
    ...(await Promise.all(['examples/doom/server/src', 'examples/doom/contracts/src', 'examples/doom/bridge/src', 'harness/src'].map(async directory =>
      (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => join(directory, file))))).flat()].sort();
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => {
    const bytes = await readFile(file);
    if (!file.startsWith('assets/')) { const target = join(root, 'source', file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    return [file, digest(bytes)];
  })));
  await write(root, 'manifest.json', { image: `docker.io/library/node@${image.manifestDigest}`, hashes,
    resources: { cpus: 1, maxCpus: 1, memory: 256, maxMemory: 256, rootDiskSize: 2048 },
    limitations: ['Real VM resource ownership and tick-accounting qualification; no model calls or gameplay-improvement claim.',
      'The first process exits deliberately after durable writes, leaving detached VMs. A separate process recovers them without resuming play.'] });
  const run = (next: string) => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, next, root], { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`VM ownership ${next} failed: ${code ?? signal}`)));
  });
  let failure: { cause: unknown } | undefined;
  try { await run('create'); } catch (cause) { failure = { cause }; }
  await run('recover');
  if (failure) throw failure.cause;
  console.log(JSON.stringify({ root, result: 'Real VM branching, exact checkpoint restoration, accounting and cross-process cleanup passed' }));
} else {
  if (!['create', 'recover'].includes(phase) || !process.argv[3]) throw new Error('Invalid qualification phase');
  await qualify(phase, resolve(process.argv[3]));
  process.exit(0);
}

async function qualify(phase: string, root: string) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { image: string; resources: VmResources; hashes: Record<string, string> };
  for (const [file, hash] of Object.entries(manifest.hashes)) assert.equal(digest(await readFile(file)), hash, `Source changed: ${file}`);
  const store = new JsonFileStore(join(root, 'resources.json'), decodeDoomEvaluationVms);
  const prior = await store.load();
  const ports = microsandboxEvaluationVmPorts(manifest);
  const owner = await DoomEvaluationVms.open(store, { ...ports, restore: async (reference, id) => {
    const runtime = await ports.restore(reference, id), branch = runtime.branch.bind(runtime);
    runtime.branch = async ids => {
      const children = await branch(ids);
      if (ids.some(id => id.endsWith('-unacknowledged'))) throw new Error('Injected missing fork acknowledgment');
      return children;
    };
    return runtime;
  } });
  if (phase === 'create') {
    assert.equal(prior, undefined);
    const ledger = new BudgetLedger({ simulationUnit: 'doom-ticks', limits: { simulation: 63, modelCalls: 0 } }, value => write(root, 'budget.json', value));
    const signal = new AbortController().signal;
    const world = await owner.create('physical-ownership', ledger, signal, [{ ticks: 7, inputs: ['left'] }]);
    const original = await world.state(), frame = await world.frame();
    const children = await world.branch([world.id + '-left', world.id + '-right']);
    for (const child of children) { assert.deepEqual(await child.state(), original); assert.deepEqual(await child.frame(), frame); }
    assert.equal(ledger.used('simulation'), 42);
    await Promise.all(children.map(child => child.step({ ticks: 7, inputs: ['forward'] })));
    const point = `mom-checkpoint-${randomUUID()}:recovery`, adapter = owner.checkpoints('physical-ownership');
    await adapter.capture(children[0]!, point);
    const state = await children[0]!.state(), expectedFrame = await children[0]!.frame();
    const restored = await adapter.restore(point, world.id + '-restored');
    assert.deepEqual(await restored.state(), state); assert.deepEqual(await restored.frame(), expectedFrame);
    assert.equal(ledger.used('simulation'), 56);
    const [restoredChild] = await restored.branch([world.id + '-restored-child']);
    assert.deepEqual(await restoredChild!.state(), state);
    assert.equal(owner.snapshot().runs[0]!.worlds.find(world => world.id === restoredChild!.id)!.restoredFrom, owner.snapshot().runs[0]!.checkpoints[0]!.identity);
    const unacknowledged = world.id + '-unacknowledged';
    await assert.rejects(restored.branch([unacknowledged]), /Injected missing fork acknowledgment/);
    assert.equal(owner.snapshot().runs[0]!.worlds.find(world => world.id === unacknowledged)!.identity, undefined);
    await restored.step({ ticks: 7, inputs: ['right'] }); assert.equal(ledger.used('simulation'), 63);
    await children[1]!.destroy(); await ledger.join(); await store.flush();
    await write(root, 'created.json', { pid: process.pid, owner: owner.snapshot().owner, original, checkpointState: state,
      originalFrame: digest(frame), checkpointFrame: digest(expectedFrame), snapshot: point, chargedTicks: ledger.used('simulation'), resources: owner.snapshot() });
    console.log(JSON.stringify({ root, phase, pid: process.pid, chargedTicks: 63, residentWorlds: owner.snapshot().runs[0]!.worlds.filter(world => !world.released).length }));
  } else {
    assert.ok(prior, 'Creation must at least publish a resource journal');
    const { Sandbox, Snapshot } = await import('microsandbox');
    const inventory = await Sandbox.listWith(builder => builder.label('evaluation-owner', owner.snapshot().owner).limit(100));
    assert.equal(inventory.sandboxes.length, 0); assert.equal(inventory.nextCursor, undefined);
    const snapshots = await Snapshot.list();
    for (const run of owner.snapshot().runs) {
      assert.ok(run.closed); assert.ok(run.worlds.every(world => world.released)); assert.ok(run.checkpoints.every(point => point.released));
      for (const world of run.worlds) {
        const { SandboxNotFoundError } = await import('microsandbox');
        await assert.rejects(Sandbox.get(world.id), SandboxNotFoundError);
      }
      for (const point of run.checkpoints) { const [group, name] = point.reference.split(':'); assert.ok(!snapshots.some(snapshot => snapshot.group === group && snapshot.name === name)); }
    }
    await write(root, 'recovered.json', { pid: process.pid, owner: owner.snapshot().owner, remainingWorlds: inventory.sandboxes.length,
      remainingSnapshots: 0, resources: owner.snapshot() });
    console.log(JSON.stringify({ root, phase, pid: process.pid, remainingWorlds: 0, remainingSnapshots: 0 }));
  }
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function write<T>(root: string, file: string, value: T): Promise<void> { return new JsonFileStore(join(root, file), input => input as T).save(value); }
