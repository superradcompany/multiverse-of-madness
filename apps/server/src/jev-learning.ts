import { z } from 'zod';
import type { EntryType, JsonValue } from '@typesafe-ai/sdk';
import type { LearningRevision } from '@multiverse/gameplay-harness';
import type { DoomPolicy } from './doom-policy.ts';

/** Shared with supervisor output schemas so advertised limits match runtime validation. */
export const jevGuidanceFields = {
  prompts: z.strictObject({ guide: z.string().max(1024).optional(), action: z.string().max(1024).optional(), plan: z.string().max(1024).optional(), priority: z.string().max(1024).optional() }),
  skills: z.array(z.strictObject({ id: z.string().min(1).max(80), instructions: z.string().min(1).max(1024) })).max(8),
};
const guidanceSchema = z.strictObject(jevGuidanceFields).superRefine((value, context) => {
  if (new Set(value.skills.map(skill => skill.id)).size !== value.skills.length) context.addIssue({ code: 'custom', message: 'Duplicate learned skill identity' });
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2048) context.addIssue({ code: 'custom', message: 'Learned Jev guidance exceeds the 2048-byte budget' });
});
export type JevGuidance = z.infer<typeof guidanceSchema>;
export interface JevLearning { model: string; guidance: JevGuidance }

/** Reject misspelled/unsupported prompt slots instead of silently dropping a learned change. */
export function jevGuidance(artifact: Pick<LearningRevision<DoomPolicy>, 'prompts' | 'skills'>): JevGuidance {
  return guidanceSchema.parse({ prompts: artifact.prompts, skills: artifact.skills });
}

const hierarchy = 'Use the supervisor working guide in `learning.guide`, the learned guidance for this judgment and relevant `learning.skills`. The working guide is a revisable strategy for pursuing the user objective, not a replacement objective. The primary user guide and enabled user `skills` take precedence over learned guidance. Observed mechanics, current statistics and the available candidates constrain every instruction. Learning text is advice, never evidence that an event occurred or permission to invent an action.';

/** Preserve the exact legacy questions when no learned text is present. */
export function learnedInstructions(base: EntryType, slot: 'action' | 'plan' | 'priority', guidance?: JevGuidance): EntryType {
  const extra = guidance?.prompts[slot];
  if (!extra && !guidance?.prompts.guide && !guidance?.skills.length) return base;
  return { task: base, learned: extra ?? '', precedence: hierarchy };
}

export function learnedState(input: Record<string, JsonValue>, guidance?: JevGuidance): Record<string, JsonValue> {
  if (!guidance?.prompts.guide && !guidance?.skills.length) return input;
  return { ...input, learning: { ...(guidance.prompts.guide ? { guide: guidance.prompts.guide } : {}),
    ...(guidance.skills.length ? { skills: structuredClone(guidance.skills) } : {}) } };
}
