import { ReplayStore } from '@multiverse/gameplay-harness/node';
import type { WorldView } from '../../contracts/src/session.ts';

/** Doom supplies the clock mapping; the harness owns storage and ancestry. */
export class Recordings extends ReplayStore<WorldView> {
  constructor(root: string, limit = 1024 ** 3,
    retention = { maxAgeMs: 24 * 60 * 60 * 1000, maxWorlds: 200 }) {
    super(root, {
      position: world => world.state.tick,
      framesPerSegment: 35,
      // Legacy footage may predate explicit fork positions in its index.
      legacyForkPosition: world => world.role === 'experiment' && world.trial
        ? world.state.tick - world.trial.elapsed : undefined,
    }, limit, retention);
  }
}
