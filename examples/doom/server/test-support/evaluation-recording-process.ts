import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { WorldView } from '../../contracts/src/session.ts';
import { openDoomEvaluationRecording } from '../src/doom-evaluation-recording.ts';

// A real recorder in a killable process, with synthetic frames and no VM/model.
const directory = process.argv[2]!;
const writer = await openDoomEvaluationRecording(directory);
const world = { id: 'root', label: 'saved main', role: 'main', state: { tick: 0, health: 90, kills: 2 } } as WorldView;
await writer.record(world, Buffer.from('frame-0')); await writer.retainPath(world.id);
for (let tick = 1; tick <= 40; tick++) {
  world.state.tick = tick;
  await writer.record(world, Buffer.from(`frame-${tick}`));
}
await new JsonFileStore(join(directory, 'session.json'), value => value).save({ version: 1, view: { mainId: world.id }, worlds: [{ view: world }] });
const index = join(directory, 'recordings', createHash('sha256').update(world.id).digest('hex'), 'index.json');
// Wait for the full 35-frame segment to be published. The last five frames
// remain buffered and must not be invented after the process is killed.
while (JSON.parse(await readFile(index, 'utf8')).ticks.at(-1) !== 35) await setTimeout(5);
process.send?.('ready');
setInterval(() => {}, 1000);
