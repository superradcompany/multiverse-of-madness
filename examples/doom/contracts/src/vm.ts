import { z } from 'zod';
import type { SandboxModificationPlan } from 'microsandbox';

export const vmResourcesSchema = z.object({
  cpus: z.number().int().min(1).max(32),
  memory: z.number().int().min(256).max(65536),
  rootDiskSize: z.number().int().min(2048).max(131072),
  maxCpus: z.number().int().min(1).max(32),
  maxMemory: z.number().int().min(256).max(65536),
}).strict().refine(r => r.maxCpus >= r.cpus && r.maxMemory >= r.memory, 'Boot ceilings must cover the requested CPU and memory');
export type VmResources = z.infer<typeof vmResourcesSchema>;
// Restored snapshots can omit creation-time disk capacity; omission means keep it.
export const vmResourceStateSchema = z.object({
  ...vmResourcesSchema.shape,
  rootDiskSize: vmResourcesSchema.shape.rootDiskSize.optional(),
}).strict().refine(r => r.maxCpus >= r.cpus && r.maxMemory >= r.memory, 'Boot ceilings must cover the requested CPU and memory');
export type VmResourceState = z.infer<typeof vmResourceStateSchema>;
export const vmSettingsSchema = z.object({
  defaults: vmResourcesSchema,
  budget: z.object({ cpus: z.number().int().min(0).max(256), memory: z.number().int().min(0).max(262144) }).strict(),
}).strict();
export type VmSettings = z.infer<typeof vmSettingsSchema>;
export const defaultVmSettings: VmSettings = { defaults: { cpus: 1, memory: 1024, rootDiskSize: 2048, maxCpus: 1, maxMemory: 1024 }, budget: { cpus: 0, memory: 0 } };
export type VmPlan = SandboxModificationPlan;
export interface VmOverview {
  settings: VmSettings;
  worlds: Array<{ id: string; label: string; role: string; resources: VmResourceState }>;
  totals: { cpus: number; memory: number };
}
