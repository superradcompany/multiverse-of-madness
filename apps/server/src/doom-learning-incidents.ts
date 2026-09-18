import { z } from 'zod';
import { canonicalJson, type CheckpointStore } from '@multiverse/gameplay-harness';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { doomIncidentCheckpoint, doomIncidentCheckpointSchema, type DoomEvaluationVmPorts } from './doom-evaluation-vms.ts';
import type { SessionCheckpoint } from './session.ts';

const recordSchema = z.strictObject({
  proposalId: z.string().uuid(), reference: z.string(), createdAt: z.number().nonnegative(),
  phase: z.enum(['capturing', 'ready', 'releasing', 'released']),
  snapshot: doomIncidentCheckpointSchema.optional(),
  evidence: z.unknown().optional(), evidenceDigest: z.string().optional(),
});
const schema = z.strictObject({ version: z.literal(1), records: z.array(recordSchema) });
export type DoomIncidentRecord = z.infer<typeof recordSchema>;
export type SavedDoomIncidents = z.infer<typeof schema>;
export function decodeDoomIncidents(value: unknown): SavedDoomIncidents {
  const saved = schema.parse(value);
  const ids = new Set<string>();
  for (const record of saved.records) {
    if (ids.has(record.proposalId) || record.reference !== `mom-checkpoint-${record.proposalId}:recovery`) throw new Error('Invalid incident ownership');
    ids.add(record.proposalId);
    if (record.snapshot && record.snapshot.reference !== record.reference) throw new Error('Incident snapshot reference changed');
    if (record.evidence !== undefined && contentRevision('doom-incident-evidence', record.evidence).version !== record.evidenceDigest) throw new Error('Incident evidence changed');
    if (record.phase === 'ready' && (!record.snapshot || !record.evidence || !record.evidenceDigest)) throw new Error('Ready incident is incomplete');
  }
  return saved;
}

export interface DoomIncidentPorts {
  store: CheckpointStore<SavedDoomIncidents>;
  capture(reference: string, signal: AbortSignal): Promise<SessionCheckpoint>;
  runtime: Pick<DoomEvaluationVmPorts, 'snapshotIdentity' | 'collect'>;
}

/** Retains host-owned snapshots while evaluators borrow them. No automatic replay on recovery. */
export class DoomLearningIncidents {
  private capturing?: string;
  private collecting = false;
  private failed?: unknown;
  private constructor(private readonly ports: DoomIncidentPorts, private readonly saved: SavedDoomIncidents) {}
  static async open(ports: DoomIncidentPorts) {
    const saved = await ports.store.load();
    return new DoomLearningIncidents(ports, saved === undefined ? { version: 1, records: [] } : decodeDoomIncidents(saved));
  }
  snapshot(): SavedDoomIncidents { return structuredClone(this.saved); }
  isCapturing(proposalId: string) { return this.capturing === proposalId; }
  ready(proposalId: string) {
    const record = this.saved.records.find(value => value.proposalId === proposalId);
    if (!record || record.phase !== 'ready') throw new Error('Proposal has no retained incident');
    return { snapshot: structuredClone(record.snapshot!), evidence: structuredClone(record.evidence) as SessionCheckpoint };
  }
  async capture(proposalId: string, signal: AbortSignal) {
    z.string().uuid().parse(proposalId); this.writable(); signal.throwIfAborted();
    if (this.saved.records.some(record => record.proposalId === proposalId)) throw new Error('Incident capture was already admitted; it cannot be replayed');
    const reference = `mom-checkpoint-${proposalId}:recovery`;
    this.capturing = proposalId;
    try {
      if (await this.ports.runtime.snapshotIdentity(reference)) throw new Error('Incident reference already exists');
      const record: DoomIncidentRecord = { proposalId, reference, createdAt: Date.now(), phase: 'capturing' };
      this.saved.records.push(record); await this.persist(); // Write intent before dispatch.
      const evidence = await this.ports.capture(reference, signal);
      signal.throwIfAborted();
      const world = evidence.worlds.find(world => world.view.id === evidence.view.mainId);
      if (!world) throw new Error('Incident has no main world');
      const identity = await this.ports.runtime.snapshotIdentity(reference);
      if (!identity) throw new Error('Incident snapshot was not published');
      record.snapshot = doomIncidentCheckpoint(reference, identity, world.view.state);
      // Session checkpoints contain optional undefined fields; persist the same JSON representation as the session store.
      record.evidence = JSON.parse(JSON.stringify(evidence));
      record.evidenceDigest = contentRevision('doom-incident-evidence', record.evidence).version;
      record.phase = 'ready'; await this.persist();
      return this.ready(proposalId);
    } finally { this.capturing = undefined; }
  }
  /** Call only after all evaluator/executor descendants have joined cleanup.
   * Ready evidence is retained for listed proposals. Interrupted captures are never reused.
   */
  async collect(retain: ReadonlySet<string>): Promise<void> {
    this.writable(); this.collecting = true;
    try {
      for (const record of this.saved.records) {
        if (record.phase === 'released' || record.phase === 'ready' && retain.has(record.proposalId)) continue;
        const identity = await this.ports.runtime.snapshotIdentity(record.reference);
        if (record.snapshot && identity && identity !== record.snapshot.identity) throw new Error('Incident physical snapshot identity changed; refusing cleanup');
        record.phase = 'releasing'; await this.persist();
        const pending = await this.ports.runtime.collect([{ reference: record.reference, identity: record.snapshot?.identity ?? identity }]);
        if (pending.length) continue;
        record.phase = 'released'; await this.persist();
      }
    } finally { this.collecting = false; }
  }
  private writable() {
    if (this.failed) throw this.failed;
    if (this.capturing || this.collecting) throw new Error('Incident owner is already working');
  }
  private async persist() {
    try { await this.ports.store.save(JSON.parse(canonicalJson(this.saved)) as SavedDoomIncidents); }
    catch (error) { this.failed = error; throw error; }
  }
}
