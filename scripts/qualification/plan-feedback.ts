import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { Jev } from '../../examples/doom/server/src/jev.ts';
import { geometryFor } from '../../examples/doom/server/src/doom-geometry.ts';
import { startPlan, planInputs } from '../../examples/doom/server/src/doom-plans.ts';
import { previousPlanFeedback } from '../../examples/doom/server/src/plan-feedback.ts';
import { prepareDoomContext } from '../../examples/doom/server/src/doom-preparation.ts';

const source = process.argv[2];
if (!source) throw new Error('Pass an observed preparation record from an earlier qualification');
const record = JSON.parse(await readFile(resolve(source), 'utf8'));
const directory = join('artifacts', 'plan-feedback', new Date().toISOString().replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const { input, output } = record, prepared = prepareDoomContext(output, input);
assert.ok(prepared.plans?.length);
const map = await geometryFor(input.state, true, true);
const classify = (id: string) => {
  const plan = prepared.plans!.find(plan => plan.id === id)!;
  const run = startPlan(plan, input.state, input.planTicks);
  const commands = planInputs(run, input.state, prepared.history, map);
  return { run, commands, feedback: previousPlanFeedback(run, input.state) };
};
const blocked = prepared.plans!.map(plan => classify(plan.id)).filter(test => test.feedback?.reason === 'target became obstructed');
assert.ok(blocked.length, 'qualification must include a recorded obstructed target');
const client = new TypeSafeClient({ timeout: 10_000, retry: { maxRetries: 0 } });
let count = 0;
const jev = new Jev('game-aware', { systemOne: (request, options) => {
  const id = ++count; writeFileSync(join(directory, `${id}-request.json`), JSON.stringify(request, null, 2));
  return client.systemOne(request, options).map(response => {
    writeFileSync(join(directory, `${id}-response.json`), JSON.stringify(response, null, 2)); return response;
  });
} });
const context = { planTicks: input.planTicks, policy: input.learning.policy, stats: input.stats,
  skills: input.userSkills.map((skill: object) => ({ ...skill, enabled: true })),
  prepared: { revision: record.revision.executor, plans: prepared.plans, features: prepared.features } };
const decisions = [];
let previous = blocked[0]!.feedback;
for (const includeFeedback of [false, true, true]) {
  const result = await jev.decide(input.state, input.objective, prepared.history, new AbortController().signal, prepared.experience,
    input.actionTicks, { ...context, previousPlan: includeFeedback ? previous : undefined });
  const classified = classify(result.plans!.selected);
  decisions.push({ includeFeedback, supplied: includeFeedback ? previous : undefined, result, immediateOutcome: classified.feedback,
    openingInputs: classified.commands });
  if (classified.feedback) previous = classified.feedback;
}
await writeFile(join(directory, 'summary.json'), JSON.stringify({ source: resolve(source), scope: 'Real Jev judgments on a retained observation; no sandbox gameplay or overall-strength claim.',
  blockedCandidates: blocked.map(test => test.run.plan.id), decisions }, null, 2));
console.log(JSON.stringify({ directory, decisions: decisions.map(d => ({ feedback: d.includeFeedback, supplied: d.supplied?.id, selected: d.result.plans!.selected, immediateFailure: d.immediateOutcome?.reason, openingInputs: d.openingInputs })) }));
