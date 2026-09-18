import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, resolvePolicy, type PolicySchema } from '../src/policy.ts';
import { contentRevision } from '../src/node/revision.ts';

type Policy = { search: { breadth: number; turns: number }; skills: string[]; objective: string | null };
const schema: PolicySchema<Policy> = {
  version: { id: 'fixture-policy', version: '1' },
  defaults: { search: { breadth: 4, turns: 3 }, skills: ['observe'], objective: null },
  parse: value => {
    const p = value as Policy;
    if (!p || Object.keys(p).sort().join() !== 'objective,search,skills' || !p.search
      || Object.keys(p.search).sort().join() !== 'breadth,turns'
      || !Number.isSafeInteger(p.search.breadth) || p.search.breadth < 1
      || !Number.isSafeInteger(p.search.turns) || p.search.turns < 1
      || !Array.isArray(p.skills) || p.skills.some(s => typeof s !== 'string')
      || (p.objective !== null && typeof p.objective !== 'string')) throw new Error('Invalid fixture policy');
    return p;
  },
};
const revision = (version: string) => ({ id: 'fixture', version });

test('policy precedence is fixed and nested fields retain lower-layer defaults', () => {
  const patch = { search: { turns: 6 }, skills: ['aim', 'move'], objective: 'survive' };
  const resolved = resolvePolicy(schema, {
    session: { revision: revision('session'), patch: { search: { breadth: 2 }, objective: null } },
    profile: { revision: revision('profile'), patch },
    adapter: { revision: revision('adapter'), patch: { search: { turns: 4 }, skills: ['navigate'] } },
  });
  assert.deepEqual(resolved.values, { search: { breadth: 2, turns: 6 }, skills: ['aim', 'move'], objective: null });
  assert.deepEqual(resolved.layers.map(layer => layer.name), ['defaults', 'adapter', 'profile', 'session']);
  patch.skills.push('later'); patch.search.turns = 10;
  assert.deepEqual(resolved.values.skills, ['aim', 'move']);
  assert.equal(resolved.values.search.turns, 6);
  assert.ok(Object.isFrozen(resolved.values.search));
  assert.ok(Object.isFrozen(resolved.layers[2]!.patch));
  assert.throws(() => Object.assign(resolved.values.search, { breadth: 99 }), TypeError);
});

test('invalid layers cannot be hidden by a later valid override', () => {
  assert.throws(() => resolvePolicy(schema, {
    adapter: { revision: revision('adapter'), patch: { search: { breadth: 0 } } },
    session: { revision: revision('session'), patch: { search: { breadth: 2 } } },
  }), /Invalid fixture policy/);
  assert.throws(() => resolvePolicy(schema, { profile: { revision: revision(''), patch: {} } }), /explicit identities/);
  assert.throws(() => resolvePolicy(schema, { profile: { revision: revision('profile'), patch: JSON.parse('{"unexpected":true}') } }), /Invalid fixture policy/);
});

test('content revisions survive JSON round trips and insertion order but track settings and provenance', () => {
  const a = resolvePolicy(schema, { session: { revision: revision('a'), patch: { search: { turns: 5, breadth: 2 } } } });
  const b = resolvePolicy(schema, { session: { revision: revision('a'), patch: { search: { breadth: 2, turns: 5 } } } });
  assert.deepEqual(contentRevision('policy', a), contentRevision('policy', b));
  assert.deepEqual(contentRevision('policy', a), contentRevision('policy', JSON.parse(JSON.stringify(a))));
  const c = resolvePolicy(schema, { session: { revision: revision('b'), patch: { search: { breadth: 2, turns: 5 } } } });
  assert.notEqual(contentRevision('policy', a).version, contentRevision('policy', c).version);
});

test('canonical data rejects silent JSON loss, cycles, prototypes and getters', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { assert.fail('must not execute getter'); } });
  const sparse: unknown[] = []; sparse.length = 2;
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), { value: undefined }, cycle, accessor, sparse,
    JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(() => canonicalJson(value));
  assert.equal(canonicalJson({ b: [1, null], a: true }), '{"a":true,"b":[1,null]}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
