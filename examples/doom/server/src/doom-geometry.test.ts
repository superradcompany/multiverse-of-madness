import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DoomMap, parseDoomMap, type Wall } from './doom-geometry.ts';

test('solid walls occlude enemies but a movement barrier is not necessarily opaque', () => {
  const wall: Wall = { a: { x: 50, y: -100 }, b: { x: 50, y: 100 }, blocksSight: true, blocksMovement: true, special: 0 };
  const map = new DoomMap([wall]);
  assert.equal(map.sight({ x: 0, y: 0 }, { x: 100, y: 0 }), 'solid-wall-blocked');
  assert.equal(map.ray({ x: 0, y: 0 }, 0), 50);
  assert.equal(map.sight({ x: 0, y: 0 }, { x: 20, y: 0 }), 'unknown');
  const fence = new DoomMap([{ ...wall, blocksSight: false }]);
  assert.equal(fence.sight({ x: 0, y: 0 }, { x: 100, y: 0 }), 'unknown');
  assert.equal(fence.ray({ x: 0, y: 0 }, 0), 50);
  assert.equal(map.ray({ x: 0, y: 0 }, 180), 512);
});

test('pinned WAD maps decode independently and invalid geometry fails explicitly', async () => {
  const wad = await readFile('assets/freedoom1.wad');
  const map = parseDoomMap(wad, 1, 1);
  assert.ok(map.walls.length > 100);
  assert.ok(map.walls.some(w => w.blocksSight));
  assert.notEqual(map.walls.length, parseDoomMap(wad, 1, 2).walls.length);
  assert.throws(() => parseDoomMap(Buffer.alloc(12), 1, 1), /Invalid Doom WAD/);
  const bad = Buffer.from(wad); bad.writeInt32LE(wad.length, 8);
  assert.throws(() => parseDoomMap(bad, 1, 1), /directory/);
  assert.throws(() => parseDoomMap(wad, 99, 99), /Missing map/);
});

test('fixed vertical openings block sight and movement while moving doors stay uncertain', () => {
  const wall: Wall = { a: { x: 50, y: 100 }, b: { x: 50, y: -100 }, blocksSight: false, blocksMovement: false, special: 0,
    front: { floor: 0, ceiling: 128, dynamic: false }, back: { floor: 160, ceiling: 256, dynamic: false } };
  const map = new DoomMap([wall], true, true);
  assert.equal(map.sight({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), 'solid-wall-blocked');
  assert.equal(map.ray({ x: 0, y: 0, z: 0 }, 0), 50);
  const door = new DoomMap([{ ...wall, back: { floor: 0, ceiling: 0, dynamic: true } }], true, true);
  assert.equal(door.sight({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), 'dynamic-opening-unknown');
});
