import type { VersionRef } from './contracts.ts';
import { canonicalJson } from './policy.ts';
import { revisionCapabilities, type ActivationRef, type LearningRevision, type Qualification, type RevisionJournal, type RevisionRules } from './revisions.ts';

export function copy<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
export function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
export function version(value: VersionRef): void {
  if (!value || Object.keys(value).sort().join() !== 'id,version' || typeof value.id !== 'string' || !value.id.trim() || typeof value.version !== 'string' || !value.version.trim()) throw new Error('Explicit revision identity and version required');
}
export function activation(value: ActivationRef): void {
  version(value?.revision);
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) throw new Error('Invalid activation epoch');
}
export function rules(value: RevisionRules): void {
  version(value?.contract);
  if (!Array.isArray(value.capabilities) || new Set(value.capabilities).size !== value.capabilities.length
    || value.capabilities.some(c => !revisionCapabilities.includes(c))) throw new Error('Invalid revision capabilities');
  if (!Number.isSafeInteger(value.maxLifetimeMs) || value.maxLifetimeMs < 1) throw new Error('Invalid proposal lifetime');
}
export function artifact<Policy>(value: LearningRevision<Policy>): void {
  if (!value || Object.keys(value).sort().join() !== 'adapter,executor,model,policy,prompts,revision,skills') throw new Error('Unexpected learning revision fields');
  for (const ref of [value.revision, value.adapter, value.executor, value.model]) version(ref);
  if (!value.prompts || typeof value.prompts !== 'object' || Array.isArray(value.prompts) || Object.values(value.prompts).some(v => typeof v !== 'string')) throw new Error('Invalid revision prompts');
  if (!Array.isArray(value.skills) || new Set(value.skills.map(s => s.id)).size !== value.skills.length
    || value.skills.some(s => Object.keys(s).sort().join() !== 'id,instructions' || typeof s.id !== 'string' || !s.id.trim() || typeof s.instructions !== 'string')) throw new Error('Invalid revision skills');
  copy(value);
}
export function qualification(value: Qualification): void {
  for (const ref of [value?.baseline, value?.candidate, value?.contract, value?.context]) version(ref);
  if (typeof value.accepted !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Invalid qualification');
  copy(value.evidence);
}
export function journal<Policy>(value: RevisionJournal<Policy>): void {
  if (value.version !== 1) throw new Error('Unsupported revision journal version');
  rules(value.rules); activation(value.active); version(value.initial);
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.proposals) || !Array.isArray(value.history)) throw new Error('Invalid revision journal');
  const refs = new Set<string>();
  for (const entry of value.artifacts) {
    artifact(entry);
    const key = canonicalJson(entry.revision);
    if (refs.has(key)) throw new Error('Duplicate revision artifact');
    refs.add(key);
  }
  const known = (ref: VersionRef) => { if (!refs.has(canonicalJson(ref))) throw new Error('Missing revision artifact'); };
  known(value.initial); known(value.active.revision);
  const ids = new Set<string>();
  for (const p of value.proposals) {
    if (!p.id?.trim() || ids.has(p.id)) throw new Error('Invalid proposal identity');
    ids.add(p.id); activation(p.basedOn); known(p.basedOn.revision); version(p.candidate); known(p.candidate); version(p.context);
    if (!['proposed', 'evaluating', 'qualified', 'rejected', 'failed', 'cancelled', 'interrupted', 'stale', 'expired', 'activated'].includes(p.status)
      || typeof p.reason !== 'string' || !p.reason.trim() || !Number.isSafeInteger(p.createdAt) || p.createdAt < 0 || !Number.isSafeInteger(p.expiresAt)
      || p.expiresAt <= p.createdAt || p.expiresAt - p.createdAt > value.rules.maxLifetimeMs) throw new Error('Invalid proposal record');
    const before = value.artifacts.find(a => same(a.revision, p.basedOn.revision))!;
    const after = value.artifacts.find(a => same(a.revision, p.candidate))!;
    const changes = revisionCapabilities.filter(c => !same(before[c], after[c]));
    if (!changes.length || !same(changes, p.capabilities) || changes.some(c => !value.rules.capabilities.includes(c))) throw new Error('Invalid proposal capabilities');
    if (p.qualification) {
      qualification(p.qualification);
      if (!same(p.qualification.baseline, p.basedOn.revision) || !same(p.qualification.candidate, p.candidate)
        || !same(p.qualification.context, p.context) || !same(p.qualification.contract, value.rules.contract)) throw new Error('Qualification identity mismatch');
    }
    if ((p.status === 'qualified' || p.status === 'activated') && !p.qualification?.accepted) throw new Error('Missing accepted qualification');
    if (p.status === 'rejected' && p.qualification?.accepted !== false) throw new Error('Missing rejected qualification');
  }
  let current: ActivationRef = { revision: value.initial, epoch: 0 };
  const activated = new Set<string>();
  const visited = new Set([canonicalJson(value.initial)]);
  for (const h of value.history) {
    activation(h.from); activation(h.to); version(h.context); known(h.to.revision);
    if (!same(current, h.from) || h.to.epoch !== h.from.epoch + 1 || !Number.isSafeInteger(h.at) || h.at < 0
      || typeof h.reason !== 'string' || !h.reason.trim() || same(h.from.revision, h.to.revision)) throw new Error('Invalid activation history');
    if (h.kind === 'activate') {
      const p = value.proposals.find(p => p.id === h.proposalId);
      if (!p || p.status !== 'activated' || activated.has(p.id) || !same(p.basedOn, h.from) || !same(p.candidate, h.to.revision)
        || !same(p.context, h.context) || h.at < p.createdAt || h.at >= p.expiresAt) throw new Error('Unqualified activation history');
      activated.add(p.id);
    } else if (h.kind !== 'rollback' || h.proposalId !== undefined || !visited.has(canonicalJson(h.to.revision))) throw new Error('Invalid rollback history');
    visited.add(canonicalJson(h.to.revision)); current = h.to;
  }
  if (!same(current, value.active) || value.proposals.some(p => p.status === 'activated' && !activated.has(p.id))) throw new Error('Activation history does not match current state');
  for (const p of value.proposals) {
    const origin = p.basedOn.epoch === 0 ? { revision: value.initial, epoch: 0 } : value.history[p.basedOn.epoch - 1]?.to;
    if (!origin || !same(origin, p.basedOn)) throw new Error('Proposal baseline was never active');
  }
}
