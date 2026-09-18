import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import type { EvaluationRun } from '@multiverse/gameplay-harness';
import type { LearningEvaluationView, EvaluationRunPreview } from '../../contracts/src/learning-evaluation.ts';
import type { SessionCheckpoint } from './session.ts';
type SavedPreview = { view: Pick<SessionCheckpoint['view'], 'stage' | 'stats' | 'decision'>; worlds: Array<Pick<SessionCheckpoint['worlds'][number], 'view' | 'frame'>> };
type SavedResult = Pick<EvaluationRun<unknown>, 'status' | 'ending' | 'error' | 'metrics'>;

/** Observes durable evaluator output only. Never attaches to, advances, or owns a VM. */
export class LearningEvaluationReader {
  private readonly cache = new Map<string, { stamp: number; size: number; value: unknown }>();
  private readonly frames = new Map<string, Buffer>();
  constructor(private readonly directory: string) {}

  async view(proposalId: string, active: boolean): Promise<LearningEvaluationView> {
    z.string().uuid().parse(proposalId);
    const root = join(this.directory, proposalId);
    const manifest = await this.read<{ contract: { id: string; scenarios: Array<{ id: string; input?: { continuation?: { stats?: { ticks: number } } } }> } }>(join(root, 'manifest.json'));
    const scenarios = manifest?.value.contract.scenarios.map(scenario => scenario.id) ?? [];
    const runs = await Promise.all(scenarios.flatMap(scenarioId => (['baseline', 'candidate'] as const).map(async role => {
      const runId = `${manifest!.value.contract.id}/${scenarioId}/${role}`;
      const id = contentRevision('doom-evaluation-run', runId).version.slice(7), directory = join(root, 'runs', id);
      const [saved, result, budget] = await Promise.all([
        this.read<SavedPreview>(join(directory, 'session.json'), value => {
          const saved = value as SessionCheckpoint;
          return { view: { stage: saved.view.stage, stats: saved.view.stats, decision: saved.view.decision ? { ...saved.view.decision, evidence: undefined } : undefined },
            worlds: saved.worlds.filter(world => world.view.role === 'main' || world.view.role === 'experiment')
              .map(world => ({ view: world.view, frame: world.frame })) };
        }),
        this.read<SavedResult>(join(directory, 'result.json'), value => {
          const { status, ending, error, metrics } = value as SavedResult; return { status, ending, error, metrics };
        }),
        this.info(join(directory, 'budget.json')),
      ]);
      const started = Boolean(saved || budget), session = saved?.value;
      const view: EvaluationRunPreview = { id, scenarioId, role,
        status: result?.value.status ?? (started ? active ? 'running' : 'interrupted' : active ? 'waiting' : 'not-run'),
        updatedAt: saved?.stamp, stage: session?.view.stage,
        error: result?.value.error, ending: result?.value.ending, metrics: result?.value.metrics, worlds: [] };
      if (session?.view.stats) {
        const { health, armor, kills, items, cells, seconds, damage } = session.view.stats;
        const inheritedSeconds = (manifest?.value.contract.scenarios.find(scenario => scenario.id === scenarioId)?.input?.continuation?.stats?.ticks ?? 0) / 35;
        view.stats = { health, armor, kills, items, cells, seconds: Math.max(0, seconds - inheritedSeconds), damage };
      }
      if (session?.view.decision?.preferences) {
        view.options = { generated: Boolean(session.view.decision.preparation), entries: session.view.decision.preferences.map(option => ({
          label: option.action, probability: option.probability, tested: option.tested,
        })) };
      }
      for (const world of session?.worlds ?? []) {
        if (world.view.role !== 'main' && world.view.role !== 'experiment') continue;
        const { id, label, role, state } = world.view;
        view.worlds.push({ id, label, role, tick: state.tick, health: state.health, kills: state.kills,
          frame: world.frame ? this.retainFrame(world.frame) : undefined });
      }
      return view;
    })));
    return { proposalId, active, scenarios, runs, total: scenarios.length * 2,
      finished: runs.filter(run => ['complete', 'error', 'cancelled', 'timeout'].includes(run.status)).length };
  }

  frame(digest: string): Buffer | undefined {
    if (!/^[a-f0-9]{64}$/.test(digest)) return;
    const value = this.frames.get(digest);
    if (value) { this.frames.delete(digest); this.frames.set(digest, value); }
    return value;
  }
  private retainFrame(encoded: string): string {
    const bytes = Buffer.from(encoded, 'base64'), id = createHash('sha256').update(bytes).digest('hex');
    this.frames.delete(id); this.frames.set(id, bytes);
    // Small, disposable spectator cache. Durable gameplay evidence remains owned by the evaluator.
    while (this.frames.size > 128) this.frames.delete(this.frames.keys().next().value!);
    return id;
  }
  private async info(path: string) {
    try { return await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  private async read<T>(path: string, project: (value: unknown) => T = value => value as T): Promise<{ value: T; stamp: number } | undefined> {
    const info = await this.info(path); if (!info) return;
    let entry = this.cache.get(path);
    if (!entry || entry.stamp !== info.mtimeMs || entry.size !== info.size) {
      entry = { stamp: info.mtimeMs, size: info.size, value: project(JSON.parse(await readFile(path, 'utf8'))) };
      this.cache.delete(path); this.cache.set(path, entry);
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
    }
    return { value: entry.value as T, stamp: entry.stamp };
  }
}
