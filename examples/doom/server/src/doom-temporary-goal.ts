import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contentRevision } from '@multiverse/gameplay-harness/node';
import { advanceScopedGoal, createScopedGoal, decodeScopedGoal, canonicalJson, type GoalFrame, type ScopedGoalRules } from '@multiverse/gameplay-harness';
import type { GameState } from '../../contracts/src/game.ts';
import type { DoomGoalTarget, DoomTemporaryGoal } from '../../contracts/src/temporary-goal.ts';

const coordinate = z.number().finite().min(-1048576).max(1048576);
export const doomGoalTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('position'), x: coordinate, y: coordinate, z: coordinate, within: z.number().min(1).max(256) }),
  z.strictObject({ kind: z.literal('health'), minimum: z.number().int().min(1).max(200) }),
  z.strictObject({ kind: z.literal('kills'), minimum: z.number().int().min(1).max(65535) }),
  z.strictObject({ kind: z.literal('key'), color: z.enum(['red', 'blue', 'yellow']) }),
  z.strictObject({ kind: z.literal('exit') }),
]);
export const doomGoalProposalSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/), instruction: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(240), evidence: z.array(z.literal('current-state')).length(1),
  duration: z.number().int().min(1).max(2100), target: doomGoalTargetSchema,
});
export type DoomGoalProposal = z.infer<typeof doomGoalProposalSchema>;
export interface DoomGoalContext { frame: GoalFrame; current?: DoomTemporaryGoal }
const rules: ScopedGoalRules<DoomGoalTarget> = {
  version: { id: 'doom-temporary-goal', version: '1' }, maxDuration: 2100,
  parseTarget: value => doomGoalTargetSchema.parse(value), hasEvidence: () => false,
};

export function decodeDoomTemporaryGoal(value: unknown): DoomTemporaryGoal {
  canonicalJson(value);
  const parsed = z.strictObject({ key: doomGoalProposalSchema.shape.key, record: z.unknown() }).parse(value);
  const record = decodeScopedGoal(parsed.record, rules);
  if (!Number.isInteger(record.draft.duration) || record.draft.instruction.length > 240 || record.draft.reason.length > 240
    || record.draft.evidence.length !== 1 || !/^doom-state:sha256:[0-9a-f]{64}$/.test(record.draft.evidence[0]!)) throw new Error('Invalid Doom goal proposal record');
  return { key: parsed.key, record };
}
export function advanceDoomTemporaryGoal(goal: DoomTemporaryGoal, frame: GoalFrame, state: GameState): DoomTemporaryGoal {
  const checked = decodeDoomTemporaryGoal(goal);
  const observation = { x: state.x, y: state.y, z: state.z, alive: state.alive, health: state.health, kills: state.kills, keys: state.keys, phase: state.phase };
  return { key: checked.key, record: advanceScopedGoal(checked.record, frame, observation, rules, (target, current) => {
    if (!current.alive) return { status: 'failed', reason: 'The player died before completing this goal' };
    let complete: boolean;
    switch (target.kind) {
      case 'position': complete = Math.hypot(current.x - target.x, current.y - target.y) <= target.within && Math.abs(current.z - target.z) <= 24; break;
      case 'health': complete = current.health >= target.minimum; break;
      case 'kills': complete = current.kills >= target.minimum; break;
      case 'key':
        if (!current.keys) return { status: 'failed', reason: 'Key inventory is not available in the observed game state' };
        complete = current.keys.includes(target.color); break;
      case 'exit': complete = current.phase === 'intermission' || current.phase === 'finale'; break;
    }
    return { status: complete ? 'completed' : 'active', reason: complete ? 'Goal condition observed in the engine state' : 'Goal condition not yet observed' };
  }) };
}
/** Repeating a key retains its original deadline/outcome; a completed or expired goal is not silently renewed. */
export function proposeDoomTemporaryGoal(proposal: DoomGoalProposal | undefined, context: DoomGoalContext | undefined,
  state: GameState): DoomTemporaryGoal | undefined {
  if (!context) { if (proposal) throw new Error('Temporary goals require a host-owned decision scope'); return; }
  const current = context.current && advanceDoomTemporaryGoal(context.current, context.frame, state);
  if (!proposal) return current;
  const { key, ...draft } = doomGoalProposalSchema.parse(proposal);
  if (current?.key === key) return current;
  if (draft.target.kind === 'position' && Math.hypot(draft.target.x - state.x, draft.target.y - state.y) > 4096) throw new Error('Temporary goal lies outside the local planning radius');
  // Resolve the proposal's alias to this exact host input. The preparation receipt retains that input.
  const reference = `doom-state:${contentRevision('doom-state', JSON.parse(JSON.stringify(state))).version}`;
  const goal = { key, record: createScopedGoal(randomUUID(), { ...draft, evidence: [reference] }, context.frame,
    { ...rules, hasEvidence: candidate => candidate === reference }) };
  return advanceDoomTemporaryGoal(goal, context.frame, state);
}
