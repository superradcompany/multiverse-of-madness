/** Game-specific similarity and outcomes stay in an injected evidence policy. */
export interface EvidencePolicy<State, Evidence> {
  capture(worldId: string, action: string, before: State, after: State): Evidence | undefined;
  distance(state: State, evidence: Evidence): number | undefined;
  group(evidence: Evidence): string;
  adverse(evidence: Evidence): boolean;
}
export interface MemoryLimits { minimumCapacity: number; maximumCapacity: number; maximumResults: number; perGroup: number }
const defaultLimits: MemoryLimits = { minimumCapacity: 1, maximumCapacity: 10000, maximumResults: 100, perGroup: 2 };

/** Bounded evidence with nearby, recent and contradictory outcomes represented. */
export class EvidenceMemory<State, Evidence> {
  records: Evidence[] = [];
  private readonly limits: MemoryLimits;
  constructor(private readonly policy: EvidencePolicy<State, Evidence>, public capacity = 128, limits: Partial<MemoryLimits> = {}) {
    this.limits = { ...defaultLimits, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Memory limits must be positive integers');
    if (this.limits.minimumCapacity > this.limits.maximumCapacity) throw new Error('Invalid memory capacity range');
    this.setCapacity(capacity);
  }
  setCapacity(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < this.limits.minimumCapacity || capacity > this.limits.maximumCapacity)
      throw new Error(`Memory capacity must be ${this.limits.minimumCapacity}–${this.limits.maximumCapacity} attempts`);
    this.capacity = capacity;
    this.records = this.records.slice(-capacity);
  }
  remember(worldId: string, action: string, before: State, after: State) {
    const record = this.policy.capture(worldId, action, before, after);
    if (record === undefined) return;
    this.records.push(structuredClone(record));
    this.records = this.records.slice(-this.capacity);
  }
  relevant(state: State, limit = 3): Evidence[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maximumResults)
      throw new Error(`Decision memory limit must be 1–${this.limits.maximumResults} attempts`);
    const matching = this.records.map((record, index) => ({ record, index, distance: this.policy.distance(state, record) }))
      .filter((item): item is { record: Evidence; index: number; distance: number } => item.distance !== undefined && Number.isFinite(item.distance) && item.distance >= 0)
      .sort((a, b) => a.distance - b.distance || b.index - a.index);
    const selected: Evidence[] = [];
    const first = matching[0]?.record;
    if (first !== undefined) {
      selected.push(first);
      const counter = matching.find(({ record }) => this.policy.group(record) === this.policy.group(first) && this.policy.adverse(record) !== this.policy.adverse(first))?.record;
      if (counter !== undefined && limit > 1) selected.push(counter);
    }
    for (const { record } of matching) {
      if (selected.length >= limit) break;
      if (selected.includes(record)) continue;
      if (selected.filter(r => this.policy.group(r) === this.policy.group(record)).length >= this.limits.perGroup) continue;
      selected.push(record);
    }
    for (const { record } of matching) { if (selected.length >= limit) break; if (!selected.includes(record)) selected.push(record); }
    return structuredClone(selected);
  }
}
