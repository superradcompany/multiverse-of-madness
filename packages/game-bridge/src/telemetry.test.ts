import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEntities } from './telemetry.ts';
test('projectile direction and distance come from engine position and heading', () => {
  const data = new DataView(new ArrayBuffer(64));
  data.setInt32(0, 100 * 65536, true);
  data.setUint32(12, 2 ** 31, true); // west, toward player at origin
  data.setInt32(16, 33, true);
  data.setUint32(24, 0x10000, true);
  data.setInt32(32 + 4, 200 * 65536, true);
  data.setInt32(32 + 16, 11, true);
  data.setInt32(32 + 20, 60, true);
  data.setUint32(32 + 24, 0x400000, true);
  const [projectile, enemy] = readEntities(data, { x: 0, y: 0, z: 0, angle: 0 });
  assert.equal(projectile!.kind, 'projectile');
  assert.equal(projectile!.distance, 100);
  assert.equal(projectile!.heading, 180);
  assert.equal(projectile!.towardPlayerAlignment, 1);
  assert.equal(enemy!.relativeBearing, 90);
  assert.equal(enemy!.distance, 200);
});
