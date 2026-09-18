import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DoomEngine } from '../../examples/doom/bridge/src/engine.ts';
import type { GameState, Step } from '../../examples/doom/contracts/src/game.ts';
import { actions, type ActionId, type Decision } from '../../examples/doom/server/src/jev.ts';
import { LabJev as Jev, type LabProfile as JevProfile } from './lab-jev.ts';
import { outcomeScore } from '../../examples/doom/server/src/session.ts';

type Case = { id: string; split: 'development' | 'heldout'; trajectory: number; trace: Step[]; state: GameState; history: GameState[]; outcomes: Record<ActionId, { state: GameState; score: number }> };
type Row = { caseId: string; profile: JevProfile; decision: Decision; score: number; regret: number; acceptable: boolean; best: number; error?: string };
const ids = Object.keys(actions) as ActionId[];
const root = 'artifacts/calibration';
const corpusPath = `${root}/corpus.json`;
const objective = 'survive and reach the exit';
const ticks = 35;
// Predeclared short-horizon proxy: existing production exploration score. A
// regret <= 5 tolerates tiny movement differences, but not one health point.
const tolerance = 5;
const load = () => DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad');
const fingerprint = (s: GameState) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
await mkdir(root, { recursive: true });
const command = process.argv[2] ?? 'report';
if (command === 'generate') {
  const cases: Case[] = [], seen = new Set<string>();
  for (let trajectory = 0; trajectory < 8; trajectory++) {
    const game = await load(), trace: Step[] = [], history: GameState[] = [];
    let seed = 1949 + trajectory * 7919;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let index = 0; index < 36; index++) {
      // Fixed seeded mixture of exploration and combat inputs. No Jev policy or
      // outcome-based cherry-picking constructs the evaluation states.
      const inputs = index % 6 < 3 ? ['forward', 'fire', 'use'] as const : actions[ids[Math.floor(random() * ids.length)]!]!.inputs;
      const step: Step = { ticks: index % 6 === 3 ? 14 : 35, inputs: [...inputs] };
      trace.push(step); history.push(game.state());
      const state = game.step(step);
      if (!state.alive || state.phase !== 'level') break;
      if (index % 6 !== 5 || seen.has(fingerprint(state))) continue;
      seen.add(fingerprint(state));
      const outcomes = {} as Case['outcomes'];
      for (const id of ids) {
        const fork = await load(); for (const prior of trace) fork.step(prior);
        assert.deepEqual(fork.state(), state, 'Replay must reproduce every observed engine field');
        const after = fork.step({ ticks, inputs: [...actions[id].inputs] });
        outcomes[id] = { state: after, score: outcomeScore(state, after, 'exploration') };
      }
      cases.push({ id: `t${trajectory}-s${index}`, split: trajectory < 4 ? 'development' : 'heldout', trajectory, trace: structuredClone(trace), state, history: history.slice(-4), outcomes });
    }
    console.log(`trajectory ${trajectory}: ${cases.filter(c => c.trajectory === trajectory).length} cases`);
  }
  await writeFile(corpusPath, JSON.stringify({ version: 1, objective, ticks, tolerance, engineSha256: createHash('sha256').update(await readFile('assets/wasmdoom.wasm')).digest('hex'), wadSha256: createHash('sha256').update(await readFile('assets/freedoom1.wad')).digest('hex'), cases }, null, 2));
} else {
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as { cases: Case[] };
  if (command === 'query') {
    const profile = process.argv[3] as JevProfile;
    assert.ok(['baseline', 'grounded', 'spatial', 'tactical'].includes(profile));
    const split = process.argv[4] ?? 'development';
    const file = `${root}/${profile}-${split}.json`;
    let rows: Row[] = [];
    try { rows = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const client = new Jev(profile);
    for (const c of corpus.cases.filter(c => c.split === split)) {
      if (rows.some(r => r.caseId === c.id)) continue;
      const decision = await client.decide(c.state, objective, c.history, AbortSignal.timeout(15_000), [], ticks);
      const best = Math.max(...Object.values(c.outcomes).map(o => o.score));
      const score = c.outcomes[decision.action].score, regret = best - score;
      const row = { caseId: c.id, profile, decision, score, regret, acceptable: regret <= tolerance, best };
      rows.push(row); await writeFile(file, JSON.stringify(rows, null, 2));
      console.log(JSON.stringify({ caseId: c.id, action: decision.action, confidence: decision.confidence, regret: Math.round(regret), acceptable: row.acceptable }));
    }
  } else if (command === 'report') {
    for (const profile of ['baseline', 'grounded', 'spatial', 'tactical']) for (const split of ['development', 'heldout']) {
      let rows: Row[]; try { rows = JSON.parse(await readFile(`${root}/${profile}-${split}.json`, 'utf8')); } catch { continue; }
      const complete = rows.length === corpus.cases.filter(c => c.split === split).length;
      const mean = (f: (r: Row) => number) => rows.reduce((sum, r) => sum + f(r), 0) / rows.length;
      console.log(JSON.stringify({ profile, split, n: rows.length, complete, accuracy: mean(r => +r.acceptable), regret: mean(r => r.regret), meanConfidence: mean(r => r.decision.confidence), meanScore: mean(r => r.score), byTrajectory: Array.from(new Set(corpus.cases.filter(c => c.split === split).map(c => c.trajectory))).map(t => { const rr = rows.filter(r => corpus.cases.find(c => c.id === r.caseId)?.trajectory === t); return { trajectory: t, n: rr.length, correct: rr.filter(r => r.acceptable).length }; }), thresholds: [0, .1, .2, .3, .4, .5, .6, .75, .9].map(threshold => { const direct = rows.filter(r => r.decision.confidence >= threshold); return { threshold, direct: direct.length, correct: direct.filter(r => r.acceptable).length }; }) }));
    }
  } else throw new Error('Use generate, query PROFILE SPLIT, or report');
}
