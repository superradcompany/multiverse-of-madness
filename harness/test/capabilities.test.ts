import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGameCapabilities, requireGameCapabilities, requirePlanCapabilities, UnsupportedGameCapabilities } from '../src/capabilities.ts';
import type { Capability, GameCapabilities } from '../src/contracts.ts';

const visual = (): GameCapabilities => ({ observations: 'visual', exactFork: false, checkpoint: false, restore: false, detached: false, render: true });

test('a visual-only game can accept ordinary plans without claiming fork, checkpoint or detached support', () => {
  const capabilities = Object.freeze(visual()), plan = Object.freeze({ id: 'move', requires: ['render'] as Capability[] });
  requirePlanCapabilities(plan, capabilities);
  requirePlanCapabilities({ id: 'wait', requires: [] }, capabilities);
  assert.throws(() => requireGameCapabilities(capabilities, ['exactFork', 'checkpoint'], 'Compare futures'), error => {
    assert.ok(error instanceof UnsupportedGameCapabilities);
    assert.equal(error.operation, 'Compare futures'); assert.deepEqual(error.missing, ['exactFork', 'checkpoint']);
    assert.match(error.message, /Compare futures.*exactFork, checkpoint/);
    assert.ok(Object.isFrozen(error.missing)); return true;
  });
  assert.deepEqual(capabilities, visual()); assert.deepEqual(plan.requires, ['render']);
});

test('capture, restore, render and exact forks are checked independently; no capability is inferred from another', () => {
  for (const capability of ['exactFork', 'checkpoint', 'restore', 'detached', 'render'] as const) {
    const capabilities = { ...visual(), render: false, [capability]: true };
    requireGameCapabilities(capabilities, [capability], 'Test feature');
    for (const other of ['exactFork', 'checkpoint', 'restore', 'detached', 'render'] as const) {
      if (other !== capability) assert.throws(() => requireGameCapabilities(capabilities, [other], 'Test feature'), UnsupportedGameCapabilities);
    }
  }
});

test('malformed declarations and requirements fail rather than silently dropping unknown features', () => {
  const invalid = [undefined, [], {}, { ...visual(), render: 1 }, { ...visual(), observations: 'pixels' },
    { ...visual(), teleport: true }, { ...visual(), checkpoint: undefined }];
  for (const value of invalid) assert.throws(() => validateGameCapabilities(value));
  for (const required of [undefined, {}, ['render', 'render'], ['observations'], ['teleport'], ['__proto__'], [true], Array(1)]) {
    assert.throws(() => requireGameCapabilities(visual(), required as Capability[], 'Test feature'));
  }
  assert.throws(() => requirePlanCapabilities({ id: '', requires: [] }, visual()), /plan identity/);
  assert.throws(() => requireGameCapabilities(visual(), [], ''), /operation name/);
});

test('declaration and requirement accessors are refused without executing them', () => {
  let invoked = false;
  assert.throws(() => validateGameCapabilities({ ...visual(), get render() { invoked = true; return true; } }));
  const required: Capability[] = ['render'];
  Object.defineProperty(required, '0', { enumerable: true, get: () => { invoked = true; return 'render'; } });
  assert.throws(() => requireGameCapabilities(visual(), required, 'Test feature'));
  assert.equal(invoked, false);
});
