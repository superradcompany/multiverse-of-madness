import { z } from 'zod';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { canonicalJson, type LearningRevision, type VersionRef } from '@multiverse/gameplay-harness';
import { contentRevision, ExecutableStore } from '@multiverse/gameplay-harness/node';
import { Jev, type DecisionMaker, type JevProfile } from './jev.ts';
import { jevGuidance } from './jev-learning.ts';
import { parseDoomLearningPolicy, type DoomPolicy } from './doom-policy.ts';

const reference = z.strictObject({ id: z.string().min(1).max(128), version: z.string().min(1).max(256) });
const artifactSchema = z.strictObject({
  revision: reference, adapter: reference, executor: reference, model: reference, policy: z.unknown(),
  prompts: z.record(z.string().min(1).max(80), z.string().max(4096)),
  skills: z.array(z.strictObject({ id: z.string().min(1).max(80), instructions: z.string().min(1).max(4096) })).max(32),
});
export type DoomLearningFields = Omit<LearningRevision<DoomPolicy>, 'revision'>;

/** Immutable data identity; host code identity is supplied by the server's build manifest. */
export function doomLearningArtifact(fields: DoomLearningFields): LearningRevision<DoomPolicy> {
  const data = structuredClone(fields);
  return { ...data, revision: contentRevision('doom-learning', data) };
}

/** Explicit model/ABI dispatch. No candidate code is imported or evaluated in this process. */
export class DoomLearningModels {
  private readonly options: {
    adapter: VersionRef; builtinExecutor: VersionRef; profile: JevProfile;
    executables: ExecutableStore; client?: Pick<TypeSafeClient, 'systemOne'>;
    executable(artifact: LearningRevision<DoomPolicy>): DecisionMaker;
    wrap?(artifact: LearningRevision<DoomPolicy>, model: DecisionMaker): DecisionMaker;
  };
  private readonly verified = new Map<string, string>();
  constructor(options: DoomLearningModels['options']) {
    this.options = { ...options, adapter: structuredClone(options.adapter), builtinExecutor: structuredClone(options.builtinExecutor) };
    reference.parse(this.options.adapter); reference.parse(this.options.builtinExecutor);
    if (this.options.builtinExecutor.id === 'learning-executor') throw new Error('Built-in Doom code must have a distinct executor identity');
  }

  baseline(policy: DoomPolicy, model = process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest'): LearningRevision<DoomPolicy> {
    return doomLearningArtifact({ policy: parseDoomLearningPolicy(policy), prompts: {}, skills: [],
      adapter: this.options.adapter, executor: this.options.builtinExecutor, model: { id: 'typesafe', version: model } });
  }

  async verify(input: LearningRevision<DoomPolicy>): Promise<void> {
    const parsed = artifactSchema.parse(input);
    const artifact = { ...parsed, policy: parseDoomLearningPolicy(parsed.policy) };
    const { revision, ...fields } = artifact;
    if (!same(input, artifact) || !same(revision, doomLearningArtifact(fields).revision)) throw new Error('Doom learning artifact content mismatch');
    if (!same(artifact.adapter, this.options.adapter)) throw new Error('Unsupported Doom learning adapter');
    if (Buffer.byteLength(canonicalJson({ prompts: artifact.prompts, skills: artifact.skills })) > 8192
      || new Set(artifact.skills.map(skill => skill.id)).size !== artifact.skills.length) throw new Error('Invalid Doom learning guidance');
    if (same(artifact.executor, this.options.builtinExecutor)) {
      if (artifact.model.id !== 'typesafe' || !/^jev-[a-zA-Z0-9._-]{1,120}$/.test(artifact.model.version)) throw new Error('Unsupported built-in Doom model');
      jevGuidance(artifact);
    } else {
      if (artifact.model.id === 'prepared-doom-jev' && /^jev-[a-zA-Z0-9._-]{1,120}$/.test(artifact.model.version)) jevGuidance(artifact);
      else if (!same(artifact.model, { id: 'isolated-doom-ranking', version: '1' })) throw new Error('Unsupported executable Doom model ABI');
      await this.options.executables.get(artifact.executor);
    }
    this.verified.set(canonicalJson(artifact.revision), canonicalJson(artifact));
  }

  model(input: LearningRevision<DoomPolicy>): DecisionMaker {
    const artifact = structuredClone(input);
    if (this.verified.get(canonicalJson(artifact.revision)) !== canonicalJson(artifact)) throw new Error('Doom learning artifact must be verified before use');
    const model = same(artifact.executor, this.options.builtinExecutor)
      ? new Jev(this.options.profile, this.options.client, { model: artifact.model.version, guidance: jevGuidance(artifact) })
      : this.options.executable(artifact);
    return this.options.wrap?.(artifact, model) ?? model;
  }
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
