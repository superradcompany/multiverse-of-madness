import type { EntityObservation } from '../../contracts/src/entity.ts';
const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;
export function readEntities(buffer: DataView, player: { x: number; y: number; z: number; angle: number }): EntityObservation[] {
  const entities: EntityObservation[] = [];
  for (let offset = 0; offset + 32 <= buffer.byteLength; offset += 32) {
    const type = buffer.getInt32(offset + 16, true);
    if (type === 0) continue;
    const flags = buffer.getUint32(offset + 24, true);
    const health = buffer.getInt32(offset + 20, true);
    const position = { x: buffer.getInt32(offset, true) / 65536, y: buffer.getInt32(offset + 4, true) / 65536, z: buffer.getInt32(offset + 8, true) / 65536 };
    const dx = position.x - player.x, dy = position.y - player.y;
    const distance = Math.hypot(dx, dy);
    const heading = buffer.getUint32(offset + 12, true) / 2 ** 32 * 360;
    const direction = { x: Math.cos(heading * Math.PI / 180), y: Math.sin(heading * Math.PI / 180) };
    const kind = flags & 0x10000 ? 'projectile' : flags & 0x400000 && health > 0 ? 'enemy' : flags & 1 ? 'pickup' : 'object';
    entities.push({ kind, engineType: type, health, position, distance,
      relativeBearing: wrap(Math.atan2(dy, dx) * 180 / Math.PI - player.angle),
      heading, direction, towardPlayerAlignment: distance ? -(dx * direction.x + dy * direction.y) / distance : 0,
    });
  }
  return entities.sort((a, b) => a.distance - b.distance);
}
