import { join } from 'node:path';
import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import { ChessSession } from './session.ts';
import type { ChessAdapter } from './adapter.ts';
import type { ChessRuntimeStore } from './runtime-store.ts';
import type { ChessDecisionModel, ChessLearningBinding } from './revisions.ts';
import type { ChessSessionCheckpoint } from './session-types.ts';

interface LearningHost { binding: ChessLearningBinding; close(): Promise<void> }

/** Caller holds the directory lease. No background work starts until the caller attaches the host. */
export async function openChessSession<Host extends LearningHost>(options: {
  directory: string; provider: ChessRuntimeStore; adapter: ChessAdapter; model: ChessDecisionModel;
  learningRequested: boolean; adoptionRequested: boolean; openLearning(): Promise<Host>;
}): Promise<{ session: ChessSession; learningHost?: Host }> {
  const { directory, provider, adapter, model } = options;
  const saved = await new JsonFileStore(join(directory, 'session.json'), value => value as ChessSessionCheckpoint).load();
  const learningEnabled = options.learningRequested || Boolean(saved?.learning);
  const adopting = learningEnabled && Boolean(saved && !saved.learning);
  if (adopting && !options.adoptionRequested)
    throw new Error('Existing plain-Jev session is preserved. Set CHESS_ADOPT_LEARNING=1 with CHESS_LEARNING=1 to adopt it explicitly.');
  // Validate and reconcile the plain session before opening any executor or supervisor.
  const plain = adopting ? await ChessSession.restore(directory, provider, adapter, model) : undefined;
  if (plain?.snapshot().batch) throw new Error('Continue the existing comparison before adopting background learning');
  let learningHost: Host | undefined;
  try {
    if (learningEnabled) learningHost = await options.openLearning();
    const session = plain ?? (saved
      ? await ChessSession.restore(directory, provider, adapter, model, learningHost?.binding)
      : await ChessSession.create(directory, provider, adapter, model, {}, learningHost?.binding));
    if (plain) await plain.adoptLearning(learningHost!.binding);
    return { session, learningHost };
  } catch (error) { await learningHost?.close(); throw error; }
}
