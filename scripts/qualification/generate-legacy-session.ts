/** Rebuild a compatibility fixture using the committed pre-extraction producer. */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime, decision } from '../../apps/server/test-support/fixture-runtime.ts';
import type { Session } from '../../apps/server/src/session.ts';
import type { Recordings } from '../../apps/server/src/recordings.ts';

const commit = 'fd777f7';
const source = resolve('.cache/legacy-session-producer');
const output = resolve('apps/server/fixtures/session-fd777f7');
await mkdir(source, { recursive: true });
const archive = execFileSync('git', ['archive', commit, 'apps/server/src', 'packages/contracts/src']);
execFileSync('tar', ['-x', '-C', source], { input: archive });
// The generator uses only methods present in the pinned producer. Current types
// document that common surface; the executed implementation comes from git.
const { Session: LegacySession } = await import(pathToFileURL(`${source}/apps/server/src/session.ts`).href) as { Session: typeof Session };
const { Recordings: LegacyRecordings } = await import(pathToFileURL(`${source}/apps/server/src/recordings.ts`).href) as { Recordings: typeof Recordings };
await rm(`${output}/recordings`, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const recordings = new LegacyRecordings(`${output}/recordings`);
await recordings.open();
const session = new LegacySession({ decide: async () => decision }, { threshold: 0.75, horizon: 7, branches: 2, paceMs: 0 });
session.setRecorder((world, frame) => recordings.record(world, frame));
session.setMainRecorder(id => recordings.retainPath(id));
session.setCheckpointAdapter({ capture: async () => {}, restore: async () => { throw new Error('Fixture generator does not restore'); }, remove: async () => {} });
await session.initialize(new Runtime('legacy-root'));
await session.saveRecoveryCheckpoint();
session.useExperience(true);
session.step(); await session.idle();
if (session.snapshot().error) throw new Error(session.snapshot().error);
await recordings.flush();
await writeFile(`${output}/session.json`, JSON.stringify(session.checkpoint(), null, 2));
await writeFile(`${output}/README.md`, `# Pre-extraction session fixture\n\nProduced by session.ts and recordings.ts from commit ${commit}, using a deterministic\nfake runtime and decision provider. The producer is extracted unchanged with git\narchive by scripts/qualification/generate-legacy-session.ts. These are persisted\nformat fixtures, not real gameplay recordings or VM snapshots.\n\nThe fixture contains an execution-checkpoint record, an unchanged source, two\ncompleted alternate futures, experience and compressed recording segments.\n`);
console.log(`Wrote the ${commit} persisted-format fixture to ${output}`);
