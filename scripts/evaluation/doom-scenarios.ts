import type { Step } from '../../examples/doom/contracts/src/game.ts';
import type { EvaluationScenario } from '@multiverse/gameplay-harness';

// Existing diagnostic starts from calibration/play.ts, now runnable without
// ignored local artifacts. These are not newly held-out acceptance scenarios.
const starts: Step[][] = [
  [{ ticks: 14, inputs: ['left'] }, { ticks: 35, inputs: ['forward'] }],
  [{ ticks: 14, inputs: ['right'] }, { ticks: 35, inputs: [] }],
  [{ ticks: 28, inputs: ['left'] }, { ticks: 35, inputs: ['forward'] }],
  [{ ticks: 28, inputs: ['right'] }, { ticks: 35, inputs: ['forward'] }],
  Array.from({ length: 3 }, () => ({ ticks: 35, inputs: [] })),
  [{ ticks: 35, inputs: ['forward'] }, { ticks: 35, inputs: ['forward'] }, { ticks: 7, inputs: ['left'] }],
];
export function doomScenario(index: number): EvaluationScenario<{ setup: Step[] }> {
  const setup = starts[index];
  if (!setup) throw new Error('Unknown diagnostic Doom start');
  return { id: `doom-start-${index}`, seed: 'doom-default-initial-rng', input: { setup: structuredClone(setup) } };
}
