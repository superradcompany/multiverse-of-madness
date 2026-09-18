import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { defaultVmSettings, vmResourceStateSchema, vmSettingsSchema, type VmResources, type VmResourceState, type VmSettings } from '../../../packages/contracts/src/vm.ts';

export class VmSettingsStore {
  private value = structuredClone(defaultVmSettings);
  private readonly file: JsonFileStore<VmSettings>;
  constructor(path: string) { this.file = new JsonFileStore(path, input => vmSettingsSchema.parse(input)); }
  async open() { this.value = await this.file.load() ?? structuredClone(defaultVmSettings); }
  get settings() { return structuredClone(this.value); }
  async update(input: VmSettings) {
    const next = vmSettingsSchema.parse(input);
    assertVmBudget([next.defaults], next.budget);
    await this.file.save(next); this.value = next;
  }
}
export function resourceTotals(resources: readonly Pick<VmResources, 'cpus' | 'memory'>[]) {
  return resources.reduce((sum, r) => ({ cpus: sum.cpus + r.cpus, memory: sum.memory + r.memory }), { cpus: 0, memory: 0 });
}
export function assertVmBudget(resources: readonly Pick<VmResources, 'cpus' | 'memory'>[], budget: VmSettings['budget']) {
  const total = resourceTotals(resources);
  if (budget.cpus && total.cpus > budget.cpus || budget.memory && total.memory > budget.memory)
    throw new Error(`VM budget exceeded: this operation needs ${total.cpus} vCPUs and ${total.memory} MiB, including the source world. Reduce futures or increase the VM budget.`);
}
/** Only expose resource fields, never environment, mounts or credentials. */
export function resourcesFromConfig(input: unknown): VmResourceState {
  const config = input as { resources?: { cpus: number; memoryMib: number; maxCpus: number; maxMemoryMib: number }; image?: { Oci?: { rootDisk?: { sizeMib?: number } } } };
  const r = config.resources;
  return vmResourceStateSchema.parse({ cpus: r?.cpus, memory: r?.memoryMib, maxCpus: r?.maxCpus, maxMemory: r?.maxMemoryMib, rootDiskSize: config.image?.Oci?.rootDisk?.sizeMib });
}
