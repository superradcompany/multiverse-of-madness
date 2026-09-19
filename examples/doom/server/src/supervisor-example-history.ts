import { isDeepStrictEqual } from 'node:util';
import type { GameState } from '../../contracts/src/game.ts';

/** Shorten only the supervisor's illustrative input, never Jev's actual history. */
export function supervisorExampleHistory(state: GameState, history: GameState[]) {
  const selected: GameState[] = [];
  let repeatsCurrentState = 0, repeatsEarlierEntry = 0;
  const window = history.slice(-2);
  for (const entry of window) {
    if (isDeepStrictEqual(entry, state)) { repeatsCurrentState++; continue; }
    if (selected.some(previous => isDeepStrictEqual(previous, entry))) { repeatsEarlierEntry++; continue; }
    selected.push(entry);
  }
  return {
    history: structuredClone(selected),
    sampling: { available: history.length, window: window.length, included: selected.length,
      repeatsCurrentState, repeatsEarlierEntry,
      scope: 'Illustrative preparation input only. Exact duplicates of state or another sampled history entry are omitted here. Live history keeps its original entries and indices, including repeats; an empty example history does not establish that the game has no history.' },
  };
}
