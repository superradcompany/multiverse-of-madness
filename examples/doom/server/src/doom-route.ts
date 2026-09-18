import type { GameState } from '../../contracts/src/game.ts';
import type { DoomMap } from './doom-geometry.ts';
type Point = { x: number; y: number; z: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x-b.x,a.y-b.y);

// Actual floor height is carried between steps; unlike the old fixed-height
// search this can traverse stairs. Locked edges are removed by geometryFor.
export function reachableRoute(
  s: GameState,
  map: DoomMap,
  qualifies: (p: Point) => boolean,
  failed: Point[] = [],
): Point[] {
  const queue: Array<Point & { parent: number }> = [
      { x: s.x, y: s.y, z: s.z, parent: -1 },
    ],
    seen = new Set(["0:0"]);
  for (let i = 0; i < queue.length && i < 16000; i++) {
    const here = queue[i]!;
    if (i && qualifies(here) && !failed.some((p) => distance(p, here) < 64)) {
      const route: Point[] = [];
      let at = i;
      while (at > 0) {
        route.unshift(queue[at]!);
        at = queue[at]!.parent;
      }
      return route;
    }
    for (const [dx, dy, angle] of [
      [32, 0, 0],
      [0, 32, 90],
      [-32, 0, 180],
      [0, -32, 270],
    ] as const) {
      const x = here.x + dx,
        y = here.y + dy,
        key = `${Math.round((x - s.x) / 32)}:${Math.round((y - s.y) / 32)}`;
      if (
        failed.some((p) => distance(p, { x, y, z: here.z }) < 24) ||
        seen.has(key) ||
        Math.hypot(x - s.x, y - s.y) > 3072 ||
        map.clearance(here, angle, 49) < 32
      )
        continue;
      seen.add(key);
      const floor = map.floorAt({ x, y }) ?? here.z;
      queue.push({ x, y, z: floor, parent: i });
    }
  }
  return [];
}
