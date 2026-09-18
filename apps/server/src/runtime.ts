import type { WorldRuntime as HarnessWorldRuntime } from '@multiverse/gameplay-harness';
import { upgradeBridge } from './bridge-upgrade.ts';
import { maintainRootDisk } from './disk-maintenance.ts';
import { resolve } from 'node:path';
import type { GameState, Step } from '../../../packages/contracts/src/game.ts';
import { SandboxGame } from './sandbox-game.ts';
import type { Sandbox } from 'microsandbox';
import { defaultVmSettings, vmResourcesSchema, vmResourceStateSchema, type VmResourceState, type VmResources, type VmPlan } from '../../../packages/contracts/src/vm.ts';
import { resourcesFromConfig } from './vm-settings.ts';

export interface WorldRuntime extends HarnessWorldRuntime<GameState, Step, Buffer> {
  branch(ids: string[]): Promise<WorldRuntime[]>;
  resources?(): Promise<VmResourceState>;
  modifyResources?(resources: VmResourceState, dryRun: boolean): Promise<VmPlan>;
}
class VmWorld implements WorldRuntime {
  private readonly game: SandboxGame;
  constructor(readonly id: string, private readonly sandbox: Sandbox) { this.game = new SandboxGame(sandbox); }
  async resources() { return resourcesFromConfig(await this.sandbox.config()); }
  async modifyResources(resources: VmResourceState, dryRun: boolean) {
    const desired = vmResourceStateSchema.parse(resources);
    const plan = await this.sandbox.modify({ ...desired, policy: 'no_restart', dryRun: true });
    if (dryRun || plan.conflicts.length || plan.changes.some(c => c.disposition !== 'live')) return plan;
    return this.sandbox.modify({ ...desired, policy: 'no_restart' });
  }
  get identity() { return this.sandbox.id; }
  state() { return this.game.state(); }
  step(step: Step) { return this.game.step(step); }
  frame() { return this.game.frame(); }
  async destroy() { await this.game.close(); await this.sandbox.destroy(); }
  async captureCheckpoint(reference: string) {
    await this.game.close();
    await maintainRootDisk(this.sandbox);
    const { Snapshot } = await import('microsandbox');
    const [group, name] = reference.split(':');
    await Snapshot.builder(name!).group(group!).fromSandbox(this.id).full().create();
  }
  async branch(ids: string[]): Promise<WorldRuntime[]> {
    await this.game.close();
    await maintainRootDisk(this.sandbox);
    const outcomes = await this.sandbox.branchMany(ids);
    const children = outcomes.flatMap(o => o.sandbox ? [new VmWorld(o.name, o.sandbox)] : []);
    const failed = outcomes.find(o => o.error);
    if (failed) {
      const cleanup = await Promise.allSettled(children.map(child => child.destroy()));
      const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      const failure = new Error(`Fork failed: ${failed.error?.message}`);
      if (errors.length) throw new AggregateError([failure, ...errors], `${failure.message}; ${errors.length} child cleanup operation(s) failed`);
      throw failure;
    }
    return children;
  }
}
export interface WorldCreationOptions { image?: string; labels?: Record<string, string> }
export async function createWorld(id: string, resources: VmResources = defaultVmSettings.defaults, options: WorldCreationOptions = {}): Promise<WorldRuntime> {
  const { Sandbox } = await import('microsandbox');
  const config = vmResourcesSchema.parse(resources);
  if (options.labels?.app !== undefined) throw new Error('World creation cannot replace the application ownership label');
  const builder = Sandbox.builder(id).image(options.image ?? 'docker.io/library/node:24-alpine')
    .detached(true).memory(config.memory).cpus(config.cpus).maxMemory(config.maxMemory).maxCpus(config.maxCpus).rootDisk(config.rootDiskSize).label('app', 'multiverse-of-madness');
  for (const [key, value] of Object.entries(options.labels ?? {})) builder.label(key, value);
  const sandbox = await builder.create();
  try {
    await sandbox.fs().mkdir('/game');
    for (const [local, guest] of [['dist/bridge.mjs', 'bridge.mjs'], ['assets/wasmdoom.wasm', 'wasmdoom.wasm'], ['assets/freedoom1.wad', 'freedoom1.wad']] as const) {
      await sandbox.fs().copyFromHost(resolve(local), `/game/${guest}`);
    }
    const launch = await sandbox.exec('node', ['-e', `
      const { spawn } = require('node:child_process');
      const { openSync } = require('node:fs');
      const log = openSync('/game/bridge.log', 'a');
      const child = spawn(process.execPath, ['/game/bridge.mjs'], {
        detached: true, stdio: ['ignore', log, log]
      });
      child.unref();
    `]);
    if (!launch.success) throw new Error(`Bridge launch failed: ${launch.stderr()}`);
    const runtime = new VmWorld(id, sandbox);
    let lastError: unknown;
    for (let i = 0; i < 30; i++) {
      try { if (!(await runtime.state()).keys) await upgradeBridge(sandbox); return runtime; } catch (error) { lastError = error; await new Promise(r => setTimeout(r, 200)); }
    }
    throw new Error(`Game bridge failed to become ready: ${lastError instanceof Error ? lastError.message : lastError}`);
  } catch (error) { await sandbox.destroy(); throw error; }
}

export async function reconnectWorld(id: string, identity: string): Promise<WorldRuntime> {
  const { Sandbox } = await import('microsandbox');
  const handle = await Sandbox.get(id);
  if (handle.id !== identity) throw new Error(`Sandbox ${id} was replaced; refusing to attach a different world`);
  const sandbox = await handle.connect();
  const runtime = new VmWorld(id, sandbox);
  if (!(await runtime.state()).keys) await upgradeBridge(sandbox);
  return runtime;
}

export async function recoverPendingWorld(id: string): Promise<WorldRuntime | undefined> {
  const { Sandbox, SandboxNotFoundError } = await import('microsandbox');
  try {
    const handle = await Sandbox.get(id);
    return await reconnectWorld(id, handle.id);
  } catch (error) { if (error instanceof SandboxNotFoundError) return; throw error; }
}
export async function destroyWorld(id: string, identity: string): Promise<void> {
  const { Sandbox, SandboxNotFoundError } = await import('microsandbox');
  try {
    const handle = await Sandbox.get(id);
    if (handle.id !== identity) throw new Error(`Refusing to delete replacement sandbox ${id}`);
    await handle.destroy();
  } catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error; }
}

export async function restoreCheckpoint(reference: string, id: string): Promise<WorldRuntime> {
  const { Sandbox } = await import('microsandbox');
  const sandbox = await Sandbox.restore(reference).name(id).forked().restore();
  const runtime = new VmWorld(id, sandbox);
  try { if (!(await runtime.state()).keys) await upgradeBridge(sandbox); return runtime; }
  catch (error) { await runtime.destroy(); throw error; }
}
