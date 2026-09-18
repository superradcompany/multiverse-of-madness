import type { SessionView, WorldView } from './session.ts';

/** The first message is a full view; subsequent messages replace session fields and changed worlds. */
export interface SessionUpdate {
  type: 'session-update';
  session: Omit<SessionView, 'worlds'>;
  worldIds: string[];
  worlds: WorldView[];
}

/** Opt-in protocol: unchanged session fields are omitted; removed fields are explicit. */
export interface SessionPatch {
  type: 'session-patch';
  session: Partial<Omit<SessionView, 'worlds'>>;
  removed: Array<keyof Omit<SessionView, 'worlds'>>;
  worldIds: string[];
  worlds: WorldView[];
}

export function applySessionUpdate(previous: SessionView, update: SessionUpdate | SessionPatch): SessionView {
  const worlds = new Map(previous.worlds.map(world => [world.id, world]));
  for (const world of update.worlds) worlds.set(world.id, world);
  const session = update.type === 'session-patch' ? { ...previous, ...update.session } : { ...update.session };
  if (update.type === 'session-patch') for (const key of update.removed) delete session[key];
  return { ...session, worlds: update.worldIds.map(id => {
    const world = worlds.get(id);
    if (!world) throw new Error('Session stream lost a world; reconnect required');
    return world;
  }) };
}
