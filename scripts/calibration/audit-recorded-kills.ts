import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { ReplayPath } from '../../packages/contracts/src/replay.ts';
import type { SessionView, WorldView } from '../../packages/contracts/src/session.ts';
const session: SessionView = await (await fetch('http://localhost:4317/api/session')).json();
const main = session.worlds.find(w => w.id === session.mainId)!;
const path: ReplayPath = await (await fetch(`http://localhost:4317/api/replay-path?worldId=${encodeURIComponent(main.id)}&untilTick=${main.state.tick}`)).json();
assert.equal(path.missingHistory, false);
let previous: WorldView | undefined, total = 0, frames = 0;
const increments: Array<{ world: string; tick: number; kills: number; increase: number }> = [];
for (const segment of path.segments) {
  const dir = `.data/recordings/${createHash('sha256').update(segment.worldId).digest('hex')}`;
  const index = JSON.parse(await readFile(`${dir}/index.json`, 'utf8')) as { segments: Array<{ file: string }> };
  const ticks = new Set(segment.ticks);
  const records = [];
  for (const part of index.segments) records.push(...JSON.parse(gunzipSync(await readFile(`${dir}/${part.file}`)).toString()) as Array<{ world: WorldView }>);
  const byTick = new Map(records.map(record => [record.world.state.tick, record.world]));
  // Current buffered frames can be read through the live recording API.
  for (const [i, tick] of segment.ticks.entries()) {
    let world = byTick.get(tick);
    if (!world) {
      const response = await fetch(`http://localhost:4317/api/recordings/${encodeURIComponent(segment.worldId)}/${segment.firstFrame + i}`);
      assert.ok(response.ok); world = (await response.json()).world as WorldView;
    }
    assert.ok(ticks.has(world.state.tick));
    const state = world.state, before = previous?.state;
    const sameMap = before && before.episode === state.episode && before.map === state.map;
    const increase = Math.max(0, state.kills - (sameMap ? before.kills : 0));
    total += increase; frames++;
    if (increase) increments.push({ world: world.id, tick, kills: state.kills, increase });
    previous = world;
  }
}
assert.equal(total, session.stats!.kills);
assert.equal(previous!.state.kills, main.state.kills);
await mkdir('artifacts/kill-audit', { recursive: true });
const report = { main: main.id, untilTick: main.state.tick, frames, mapKills: main.state.kills, replayKills: total, displayedRunKills: session.stats!.kills, allWorldKills: session.stats!.attempts.kills, increments };
await writeFile('artifacts/kill-audit/live-recording.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
