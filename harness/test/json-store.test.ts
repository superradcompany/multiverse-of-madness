import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/node/json-store.ts';
const decode = (value: unknown): { version: number; turn: number } => {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('turn' in value) || typeof value.turn !== 'number') throw new Error('Unsupported turn snapshot');
  return { version: 1, turn: value.turn };
};
test('atomic store serializes writes and delegates persisted-format validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gameplay-store-'));
  try {
    const path = join(dir, 'state.json'), store = new JsonFileStore(path, decode);
    assert.equal(await store.load(), undefined);
    const state = { version: 1, turn: 1 };
    const first = store.save(state);state.turn=2;const second=store.save(state);
    await Promise.all([first,second]);await store.flush();
    assert.deepEqual(await new JsonFileStore(path,decode).load(), {version:1,turn:2});
    await writeFile(path,JSON.stringify({version:2,turn:2}));
    await assert.rejects(store.load(),/Unsupported/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
