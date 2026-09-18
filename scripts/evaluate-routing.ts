import './runtime-env.ts';
import './build-bridge.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Session, outcomeScore } from '../examples/doom/server/src/session.ts';
import { Jev, type DecisionMaker } from '../examples/doom/server/src/jev.ts';
import { createWorld, type WorldRuntime } from '../examples/doom/server/src/runtime.ts';

// Matched starts and equal game-time budgets. Review holds and animation pacing
// are disabled for every policy. This measures a policy, not the staged UI.
const objective = 'survive and reach the exit';
const policies = [
  { name: 'jev-alone', threshold: 0 },
  { name: 'uncertainty-gated', threshold: 0.75 },
  { name: 'always-branch', threshold: 1.01 },
] as const;
const rounds = 6;
const budget = rounds * 35;
const results: object[] = [];
const stamp = Date.now();
const client = new Jev();
const source = await createWorld(`mom-eval-${stamp}`);
await mkdir('artifacts', { recursive: true });
try {
  for (let scenario = 0; scenario < 3; scenario++) {
    // Fixed, disclosed setup sequence. These are opening states, not selected wins.
    if (scenario) for (let i = 0; i < 3; i++) await source.step({ ticks: 35, inputs: ['forward', 'use'] });
    const initial = await source.state();
    const children = await source.branch(policies.map(p => `mom-eval-${stamp}-s${scenario}-${p.name}`));
    const unowned = new Set<WorldRuntime>(children);
    try {
      // Rotate order to reduce systematic warm-up/order effects.
      for (let offset = 0; offset < policies.length; offset++) {
        const index = (scenario + offset) % policies.length;
        const policy = policies[index]!, child = children[index]!;
        assert.deepEqual(await child.state(), initial, 'Policies must start with identical engine state');
        const decisions: Array<{ confidence: number; latencyMs: number; model: string }> = [];
        const decider: DecisionMaker = { decide: async (...args) => {
          let d;
          for (let attempt = 0; ; attempt++) {
            try { d = await client.decide(...args); break; }
            catch (error) {
              if (attempt >= 2 || !String(error).includes('529')) throw error;
              await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
          }
          decisions.push({ confidence: d.confidence, latencyMs: d.latencyMs, model: d.model });
          return d;
        } };
        const session = new Session(decider, { threshold: policy.threshold, horizon: 35, branches: 4, paceMs: 0, frameTicks: 7 });
        await session.initialize(child); unowned.delete(child);
        const lastTicks = new Map([[child.id, initial.tick]]);
        let simulationTicks = 0, stopping = false;
        session.on('change', () => {
          const view = session.snapshot();
          for (const world of view.worlds) {
            simulationTicks += Math.max(0, world.state.tick - (lastTicks.get(world.id) ?? world.state.tick));
            lastTicks.set(world.id, world.state.tick);
          }
          const main = view.worlds.find(w => w.id === view.mainId)!;
          if (!stopping && main.state.tick >= initial.tick + budget) { stopping = true; void session.pause(); }
        });
        try {
          const started = performance.now();
          session.resume(); await session.idle();
          const elapsedMs = performance.now() - started;
          const view = session.snapshot(), final = view.worlds.find(w => w.id === view.mainId)!.state;
          const row = { scenario, startingTick: initial.tick, policy: policy.name, threshold: policy.threshold,
            gameTicks: final.tick - initial.tick, simulationTicks, elapsedMs, decisions, routing: view.routing,
            alive: final.alive, health: final.health, healthChange: final.health - initial.health,
            kills: final.kills - initial.kills, displacement: Math.hypot(final.x - initial.x, final.y - initial.y),
            score: outcomeScore(initial, final, 'exploration'), error: view.error ?? null };
          results.push(row);
          console.log(JSON.stringify({ ...row, decisions: decisions.length }));
          await writeFile('artifacts/routing-evaluation.json', JSON.stringify({
            date: new Date().toISOString(), objective, budgetTicks: budget, trialHorizonTicks: 35,
            scenarios: 'Three opening checkpoints separated by 105 ticks of forward/use; same engine state per policy.',
            methodology: 'Six one-second decision rounds per policy. Same action set and score. Jev is called independently as trajectories diverge. No animation pacing/review holds. 529 overload responses are retried at most twice after 2/4 seconds, included in wall time. Source setup and initial cloning are excluded from elapsed time. Simulation ticks include discarded branches; this is a compute proxy, not CPU billing.',
            limitations: 'Small exploratory evaluation on one map. Short equal 35-tick trials differ from the live 70-tick branching horizon. Displacement is not exit progress. No statistical or threshold calibration claim. Inspect errors and completed game budgets before comparing outcomes.',
            results,
          }, null, 2));
        } finally { await session.close(); }
      }
    } finally { for (const world of unowned) await world.destroy(); }
  }
} finally { await source.destroy(); }
