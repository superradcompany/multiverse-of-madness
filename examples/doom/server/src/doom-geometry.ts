import { readFile } from 'node:fs/promises';
import type { GameState, KeyColor } from '../../contracts/src/game.ts';

type Point = { x: number; y: number; z?: number };
type Sector = { id?: number; floor: number; ceiling: number; dynamic: boolean };
export const lockedKey = (special: number): KeyColor | undefined => [26,32,99,133].includes(special) ? 'blue' : [27,34,136,137].includes(special) ? 'yellow' : [28,33,134,135].includes(special) ? 'red' : undefined;
export type Wall = { a: Point; b: Point; blocksSight: boolean; blocksMovement: boolean; special: number; front?: Sector; back?: Sector };
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
export function intersection(from: Point, to: Point, wall: Wall): number | undefined {
  const r = { x: to.x - from.x, y: to.y - from.y }, s = { x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y };
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const q = { x: wall.a.x - from.x, y: wall.a.y - from.y };
  const t = cross(q, s) / denominator, u = cross(q, r) / denominator;
  return t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 ? t : undefined;
}

export class DoomMap {
  private buckets = new Map<string, Wall[]>();
  constructor(readonly walls: Wall[], readonly vertical = false, readonly dynamicUncertain = false) {
    for (const wall of walls) for (let x = Math.floor(Math.min(wall.a.x, wall.b.x)/256); x <= Math.floor(Math.max(wall.a.x, wall.b.x)/256); x++) for (let y = Math.floor(Math.min(wall.a.y, wall.b.y)/256); y <= Math.floor(Math.max(wall.a.y, wall.b.y)/256); y++) {
      const k = `${x}:${y}`, list = this.buckets.get(k) ?? []; list.push(wall); this.buckets.set(k,list);
    }
  }
  private nearby(from: Point, to: Point): Wall[] {
    const found = new Set<Wall>();
    for (let x=Math.floor(Math.min(from.x,to.x)/256);x<=Math.floor(Math.max(from.x,to.x)/256);x++) for(let y=Math.floor(Math.min(from.y,to.y)/256);y<=Math.floor(Math.max(from.y,to.y)/256);y++) for(const w of this.buckets.get(`${x}:${y}`) ?? []) found.add(w);
    return [...found];
  }
  floorAt(point: Point): number | undefined {
    let nearest = Infinity, floor: number | undefined;
    for (const w of this.nearby({x:point.x-256,y:point.y-256},{x:point.x+256,y:point.y+256})) {
      const dx=w.b.x-w.a.x,dy=w.b.y-w.a.y,len=dx*dx+dy*dy;
      if(!len)continue;
      const f=Math.max(0,Math.min(1,((point.x-w.a.x)*dx+(point.y-w.a.y)*dy)/len));
      const d=Math.hypot(point.x-w.a.x-f*dx,point.y-w.a.y-f*dy);
      const sector=dx*(point.y-w.a.y)-dy*(point.x-w.a.x)>0?w.back:w.front;
      if(d<nearest){nearest=d;floor=sector?.floor;}
    }
    return floor;
  }
  sight(from: Point, to: Point): 'solid-wall-blocked' | 'dynamic-opening-unknown' | 'unknown' {
    let dynamic = false;
    let bottom = (to.z ?? 0) - ((from.z ?? 0) + 42), top = bottom + 100;
    for (const wall of this.nearby(from, to)) {
      const fraction = intersection(from, to, wall);
      if (fraction === undefined) continue;
      if (wall.blocksSight) return 'solid-wall-blocked';
      if (this.dynamicUncertain && (wall.front?.dynamic || wall.back?.dynamic)) dynamic = true;
      if (!this.vertical || from.z === undefined || to.z === undefined || !wall.front || !wall.back || wall.front.dynamic || wall.back.dynamic) continue;
      // Approximate 100-unit target column, not engine-exact actor height.
      // Passing this check never establishes visibility; moving openings stay unknown.
      const floor = Math.max(wall.front.floor, wall.back.floor), ceiling = Math.min(wall.front.ceiling, wall.back.ceiling);
      if (floor >= ceiling) return 'solid-wall-blocked';
      bottom = Math.max(bottom, (floor - from.z - 42) / fraction);
      top = Math.min(top, (ceiling - from.z - 42) / fraction);
      if (top <= bottom) return 'solid-wall-blocked';
    }
    return dynamic ? 'dynamic-opening-unknown' : 'unknown';
  }
  ray(from: Point, degrees: number, distance = 512) {
    const to = { x: from.x + Math.cos(degrees * Math.PI / 180) * distance, y: from.y + Math.sin(degrees * Math.PI / 180) * distance };
    let nearest = distance;
    let floor = from.z;
    const crossings = this.nearby(from, to).map(wall => ({ wall, t: intersection(from, to, wall) })).filter((c): c is { wall: Wall; t: number } => c.t !== undefined).sort((a, b) => a.t - b.t);
    for (const { wall, t } of crossings) {
      if (wall.blocksMovement) { nearest = t * distance; break; }
      if (!this.vertical || floor === undefined) continue;
      const side = cross({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y }, { x: to.x - wall.a.x, y: to.y - wall.a.y });
      const next = side > 0 ? wall.back : wall.front;
      if (!next || next.dynamic) continue;
      if (next.floor - floor > 24 || next.ceiling - Math.max(floor, next.floor) < 56) { nearest = t * distance; break; }
      floor = next.floor;
    }
    return Math.round(nearest);
  }
  // Conservative swept player footprint. Side rays catch wall endpoints that
  // a center-only ray misses; the front allowance includes the 16-unit radius.
  clearance(from: Point, degrees: number, distance = 512) {
    const radians = degrees * Math.PI / 180;
    return Math.max(0, Math.min(...[-16, -8, 0, 8, 16].map(offset => this.ray({
      ...from, x: from.x - Math.sin(radians) * offset, y: from.y + Math.cos(radians) * offset,
    }, degrees, distance))) - 16);
  }
  observe(state: GameState) {
    const ray = (offset: number) => this.ray(state, state.angle + offset);
    const nearbyLocks = this.walls.flatMap((wall, line) => {
      const requiredKey = lockedKey(wall.special);
      const distance = Math.hypot(state.x - (wall.a.x + wall.b.x) / 2, state.y - (wall.a.y + wall.b.y) / 2);
      return requiredKey && distance < 128 ? [{ line, requiredKey, distance: Math.round(distance), keyOwned: state.keys ? state.keys.includes(requiredKey) : 'unknown', opening: 'unknown' }] : [];
    }).sort((a,b) => a.distance-b.distance).slice(0,3);
    return { nearbyLocks, staticBarrierDistance: { ahead: ray(0), left45: ray(45), left: ray(90), behind: ray(180), right: ray(-90), right45: ray(-45) },
      limits: 'Ray distances to static movement barriers, capped at 512 units. Center rays are not collision-free routes. Unknown: moving doors/lifts, current floor/ceiling openings, other actors. Solid-wall-blocked proves occlusion; unknown does NOT prove visibility.' };
  }
}

export function parseDoomMap(wad: Buffer, episode: number, map: number, vertical = false, dynamicUncertain = false): DoomMap {
  if (wad.length < 12 || !['IWAD', 'PWAD'].includes(wad.toString('ascii', 0, 4))) throw new Error('Invalid Doom WAD');
  const count = wad.readInt32LE(4), directory = wad.readInt32LE(8);
  if (count < 0 || directory < 12 || directory + count * 16 > wad.length) throw new Error('Invalid WAD directory');
  const lumps: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const offset = directory + i * 16, start = wad.readInt32LE(offset), size = wad.readInt32LE(offset + 4);
    if (start < 0 || size < 0 || start + size > wad.length) throw new Error('Invalid WAD lump bounds');
    lumps.push({ name: wad.toString('ascii', offset + 8, offset + 16).replace(/\0.*$/, ''), data: wad.subarray(start, start + size) });
  }
  const marker = lumps.findIndex(l => l.name === `E${episode}M${map}`);
  if (marker < 0) throw new Error(`Missing map E${episode}M${map}`);
  const end = lumps.findIndex((l, i) => i > marker && /^(E\dM\d|MAP\d\d)$/.test(l.name));
  const entries = lumps.slice(marker + 1, end < 0 ? undefined : end);
  const vertices = entries.find(l => l.name === 'VERTEXES')?.data, lines = entries.find(l => l.name === 'LINEDEFS')?.data;
  if (!vertices || !lines || vertices.length % 4 || lines.length % 14) throw new Error('Invalid classic Doom map geometry');
  const point = (index: number): Point => {
    if (index * 4 + 4 > vertices.length) throw new Error('Invalid map vertex reference');
    return { x: vertices.readInt16LE(index * 4), y: vertices.readInt16LE(index * 4 + 2) };
  };
  const sides = entries.find(l => l.name === 'SIDEDEFS')?.data, sectorData = entries.find(l => l.name === 'SECTORS')?.data;
  if (!sides || !sectorData || sides.length % 30 || sectorData.length % 26) throw new Error('Invalid map sectors');
  const sectors: Sector[] = [];
  for (let i = 0; i < sectorData.length; i += 26) sectors.push({ id: i / 26, floor: sectorData.readInt16LE(i), ceiling: sectorData.readInt16LE(i + 2), dynamic: sectorData.readUInt16LE(i + 24) !== 0 });
  const sector = (side: number) => {
    if (side === 65535) return undefined;
    if (side * 30 + 30 > sides.length) throw new Error('Invalid map side reference');
    const result = sectors[sides.readUInt16LE(side * 30 + 28)];
    if (!result) throw new Error('Invalid map sector reference');
    return result;
  };
  const walls: Wall[] = [];
  for (let i = 0; i < lines.length; i += 14) {
    const flags = lines.readUInt16LE(i + 4), oneSided = !(flags & 4) || lines.readUInt16LE(i + 12) === 65535;
    const front = sector(lines.readUInt16LE(i + 10)), back = sector(lines.readUInt16LE(i + 12)), special = lines.readUInt16LE(i + 6);
    // Untagged manual doors act on the back sector; tags mark remote lifts/doors.
    if (special && back) back.dynamic = true;
    walls.push({ front, back, a: point(lines.readUInt16LE(i)), b: point(lines.readUInt16LE(i + 2)), blocksSight: oneSided, blocksMovement: oneSided || !!(flags & 1), special: lines.readUInt16LE(i + 6) });
  }
  return new DoomMap(walls, vertical, dynamicUncertain);
}
let wadPromise: Promise<Buffer> | undefined;
const maps = new Map<string, Promise<DoomMap>>();
export function geometryFor(state: Pick<GameState, 'episode' | 'map' | 'keys'>, vertical = false, dynamicUncertain = false): Promise<DoomMap> {
  const key = `${state.episode}:${state.map}:${vertical}:${dynamicUncertain}:${state.keys?.slice().sort().join(",") ?? "unknown"}`;
  let pending = maps.get(key);
  if (!pending) {
    wadPromise ??= readFile('assets/freedoom1.wad');
    pending = wadPromise.then(wad => {
      const map = parseDoomMap(wad, state.episode, state.map, vertical, dynamicUncertain);
      return new DoomMap(map.walls.map(w => lockedKey(w.special) && !state.keys?.includes(lockedKey(w.special)!) ? { ...w, blocksMovement: true, blocksSight: true } : w), vertical, dynamicUncertain);
    });
    maps.set(key, pending);
  }
  return pending;
}
