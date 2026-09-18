import type { SessionView } from '../../contracts/src/session.ts';
import type { SessionPatch, SessionUpdate } from '../../contracts/src/session-stream.ts';

/** Per-connection delivery cursor. Advance it only when the socket accepts the update. */
export class SessionStream {
  private worlds = new Map<string, string>();
  private fields = new Map<keyof Omit<SessionView, 'worlds'>, string>();
  constructor(view: SessionView, private readonly mode: 'updates' | 'patches' = 'updates') { this.update(view); }
  update(view: SessionView): SessionUpdate | SessionPatch {
    const { worlds, ...session } = view;
    const encoded = new Map(worlds.map(world => [world.id, JSON.stringify(world)]));
    const changed = worlds.filter(world => this.worlds.get(world.id) !== encoded.get(world.id));
    this.worlds = encoded;
    const common = { worldIds: worlds.map(world => world.id), worlds: changed };
    if (this.mode === 'updates') return { type: 'session-update', session, ...common };
    const fields = new Map<keyof typeof session, string>();
    const patch: SessionPatch['session'] = {};
    for (const key of Object.keys(session) as Array<keyof typeof session>) {
      const value = JSON.stringify(session[key]);
      if (value === undefined) continue;
      fields.set(key, value);
      if (value !== this.fields.get(key)) Object.assign(patch, { [key]: session[key] });
    }
    const removed = [...this.fields.keys()].filter(key => !fields.has(key));
    this.fields = fields;
    return { type: 'session-patch', session: patch, removed, ...common };
  }
}
