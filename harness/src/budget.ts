export const budgetResources = ['simulation', 'modelCalls', 'inputTokens', 'outputTokens', 'costMicros', 'executorCalls', 'executorWallMs', 'supervisorCalls'] as const;
export type BudgetResource = typeof budgetResources[number];
export type ResourceAmounts = Partial<Record<BudgetResource, number>>;
export interface BudgetSpec {
  /** Adapter-defined integer quantum, for example doom-ticks or board-turns. */
  simulationUnit: string;
  limits: ResourceAmounts;
}
export interface BudgetEntry {
  id: number;
  owner: string;
  operation: string;
  reserved: ResourceAmounts;
  usage?: ResourceAmounts;
  /** Measured but uncapped resources. Failed work may leave their usage unknown. */
  observe?: BudgetResource[];
  status: 'pending' | 'complete' | 'failed' | 'interrupted' | 'overrun';
  error?: string;
}
export interface BudgetSnapshot { version: 1; spec: BudgetSpec; entries: BudgetEntry[] }
export class BudgetExhausted extends Error {
  constructor(readonly resource: BudgetResource, readonly requested: number, readonly remaining: number) {
    super(`Budget exhausted: ${resource} needs ${requested}, remaining ${remaining}`);
    this.name = 'BudgetExhausted';
  }
}
export class BudgetOverrun extends Error {
  constructor(readonly resource: BudgetResource) { super(`Operation exceeded its reserved ${resource} budget`); this.name = 'BudgetOverrun'; }
}

/**
 * Host-owned accounting. Reserve every bounded operation before dispatch, across
 * all worlds and model calls. Failed/unknown work consumes its full reservation.
 * A persist callback must atomically publish snapshots for restart durability.
 */
export class BudgetLedger {
  private readonly spec: BudgetSpec;
  private readonly entries: BudgetEntry[];
  private writes: Promise<void> = Promise.resolve();
  private storageFailure?: { cause: unknown };
  private overrun = false;
  private sealed = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(spec: BudgetSpec, private readonly persist?: (snapshot: BudgetSnapshot) => Promise<void>, saved?: BudgetSnapshot) {
    if (!spec.simulationUnit?.trim()) throw new Error('Budget requires an explicit simulation unit');
    this.spec = { simulationUnit: spec.simulationUnit, limits: amounts(spec.limits, true) };
    this.entries = [];
    if (saved !== undefined) {
      if (!saved || !saved.spec || saved.version !== 1 || saved.spec.simulationUnit !== this.spec.simulationUnit
        || !equalAmounts(saved.spec.limits, this.spec.limits, true) || !Array.isArray(saved.entries)) throw new Error('Saved budget does not match the experiment contract');
      for (const [index, entry] of saved.entries.entries()) {
        if (entry.id !== index + 1 || !entry.owner?.trim() || !entry.operation?.trim()
          || !['pending', 'complete', 'failed', 'interrupted', 'overrun'].includes(entry.status)
          || (entry.status === 'pending' ? entry.usage !== undefined : entry.usage === undefined)) throw new Error('Invalid saved budget entry');
        const observed = this.observed(entry.observe, entry.reserved);
        const reserved = amounts(entry.reserved), usage = entry.usage === undefined ? reserved : amounts(entry.usage);
        const exceeded = budgetResources.some(key => !observed.includes(key) && (usage[key] ?? 0) > (reserved[key] ?? 0));
        if (exceeded !== (entry.status === 'overrun')) throw new Error('Invalid saved budget overrun');
        if (['failed', 'interrupted'].includes(entry.status) && !equalAmounts(usage, reserved)) throw new Error('Uncertain work must retain its full reservation');
        this.entries.push({ ...structuredClone(entry), reserved, usage, status: entry.status === 'pending' ? 'interrupted' : entry.status });
      }
      this.overrun = this.entries.some(entry => entry.status === 'overrun');
      for (const key of budgetResources) if (this.used(key) > (this.spec.limits[key] ?? Infinity) && !this.overrun) throw new Error('Saved usage exceeds the experiment budget');
    }
  }
  snapshot(): BudgetSnapshot { return structuredClone({ version: 1, spec: this.spec, entries: this.entries }); }
  used(resource: BudgetResource): number {
    const total = this.entries.reduce((sum, entry) => sum + ((entry.usage ?? entry.reserved)[resource] ?? 0), 0);
    if (!Number.isSafeInteger(total)) throw new Error('Budget accounting overflow');
    return total;
  }
  remaining(resource: BudgetResource): number { return Math.max(0, (this.spec.limits[resource] ?? Infinity) - this.used(resource)); }
  async flush(): Promise<void> { await this.writes; }

  get pending(): number { return this.active.size; }
  seal(): void { this.sealed = true; }
  async join(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
    await this.flush();
  }
  run<T>(request: { owner: string; operation: string; reserve: ResourceAmounts; observe?: BudgetResource[] }, work: () => Promise<{ value: T; usage: ResourceAmounts }>, signal?: AbortSignal): Promise<T> {
    if (this.sealed) return Promise.reject(new Error('Evaluation budget is sealed'));
    const operation = this.execute(request, work, signal);
    this.active.add(operation);
    void operation.then(() => { this.active.delete(operation); }, () => { this.active.delete(operation); });
    return operation;
  }
  private async execute<T>(request: { owner: string; operation: string; reserve: ResourceAmounts; observe?: BudgetResource[] }, work: () => Promise<{ value: T; usage: ResourceAmounts }>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.storageFailure) throw this.storageFailure.cause;
    if (this.overrun) throw new Error('An earlier operation exceeded its reservation; the experiment cannot continue');
    if (!request.owner?.trim() || !request.operation?.trim()) throw new Error('Budgeted work requires an owner and operation');
    const reserved = amounts(request.reserve);
    const observed = this.observed(request.observe, reserved);
    for (const resource of budgetResources) {
      const quantity = reserved[resource] ?? 0;
      if (quantity > this.remaining(resource)) throw new BudgetExhausted(resource, quantity, this.remaining(resource));
      if (!Number.isSafeInteger(this.used(resource) + quantity)) throw new Error('Budget accounting overflow');
    }
    const entry: BudgetEntry = { id: this.entries.length + 1, owner: request.owner, operation: request.operation, reserved, status: 'pending' };
    if (observed.length) entry.observe = observed;
    this.entries.push(entry); // Synchronous reservation fences concurrent admissions.
    await this.publish();
    let result: { value: T; usage: ResourceAmounts };
    try {
      signal?.throwIfAborted();
      result = await work(); // Dispatched work must settle even if cancellation arrives.
      const usage = amounts(result.usage);
      entry.usage = usage;
      const exceeded = budgetResources.find(resource => !observed.includes(resource) && (usage[resource] ?? 0) > (reserved[resource] ?? 0));
      if (exceeded) {
        this.overrun = true; entry.status = 'overrun'; entry.error = `Reservation exceeded: ${exceeded}`;
        await this.publish();
        throw new BudgetOverrun(exceeded);
      }
      entry.status = 'complete';
    } catch (error) {
      if (entry.status === 'pending') {
        entry.status = 'failed'; entry.usage = { ...reserved };
        entry.error = error instanceof Error ? error.message.slice(0, 1000) : 'Operation failed';
        try { await this.publish(); }
        catch (storageError) { throw new AggregateError([error, storageError], 'Operation and budget publication failed'); }
      }
      throw error;
    }
    await this.publish();
    return result.value;
  }
  private observed(resources: BudgetResource[] = [], reserved: ResourceAmounts): BudgetResource[] {
    if (!Array.isArray(resources) || new Set(resources).size !== resources.length
      || resources.some(key => !budgetResources.includes(key) || this.spec.limits[key] !== undefined || reserved[key] !== undefined)) {
      throw new Error('Observed-only resources must be declared, uncapped and separate from reservations');
    }
    return [...resources];
  }
  private publish(): Promise<void> {
    const snapshot = this.snapshot();
    this.writes = this.writes.then(async () => {
      try { await this.persist?.(snapshot); }
      catch (cause) { this.storageFailure = { cause }; throw cause; }
    });
    return this.writes;
  }
}
function amounts(value: ResourceAmounts, keepZeros = false): ResourceAmounts {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid resource amounts');
  const result: ResourceAmounts = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!budgetResources.includes(key as BudgetResource) || !Number.isSafeInteger(amount) || amount < 0) throw new Error('Resource amounts must be nonnegative safe integers');
    if (amount !== 0 || keepZeros) result[key as BudgetResource] = amount;
  }
  return result;
}
function equalAmounts(a: ResourceAmounts, b: ResourceAmounts, requireSameLimits = false): boolean {
  const left = amounts(a, requireSameLimits), right = amounts(b, requireSameLimits);
  return budgetResources.every(key => requireSameLimits ? left[key] === right[key] : (left[key] ?? 0) === (right[key] ?? 0));
}
