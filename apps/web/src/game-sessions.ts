export interface GameSessionLink { id: string; game: string; gameLabel: string; title: string; description: string; url: string }

/** Public build configuration: only navigation metadata, never credentials or session state. */
export function parseGameSessions(value: unknown): GameSessionLink[] {
  if (!Array.isArray(value)) throw new Error('GAME_SESSIONS_JSON must be an array');
  const sessions = value.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'description,game,gameLabel,id,title,url'
      || Object.values(item).some(field => typeof field !== 'string' || !field.trim())) throw new Error('Each game session needs id, game, gameLabel, title, description and url');
    const entry = item as GameSessionLink, url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Game session URLs must use HTTP(S) without credentials');
    return { ...entry, url: url.href };
  });
  if (new Set(sessions.map(session => session.id)).size !== sessions.length
    || new Set(sessions.map(session => session.url)).size !== sessions.length) throw new Error('Game session IDs and URLs must be unique');
  return sessions;
}

/** Local demo defaults are not assumed on a deployed host; deployments supply their own catalog. */
export function localGameSessions(location: string): GameSessionLink[] {
  const current = new URL(location);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(current.hostname)) return [];
  const url = (port: number) => { const value = new URL(current.origin); value.port = String(port); return value.href; };
  return [
    { id: 'doom-main', game: 'doom', gameLabel: 'Doom', title: 'Main run', description: 'Explore futures and follow the selected route.', url: url(4320) },
    { id: 'chess-original', game: 'chess', gameLabel: 'Chess', title: 'Original run', description: 'Your original game, checkpoints and replay.', url: url(4321) },
    { id: 'chess-learning', game: 'chess', gameLabel: 'Chess', title: 'Learning run', description: 'Jev plays with background strategy reviews.', url: url(4322) },
  ];
}
export function sameSessionUrl(a: string, b: string): boolean {
  const first = new URL(a), second = new URL(b);
  const path = (value: URL) => value.pathname.replace(/\/(?:index|chess)\.html$/, '/').replace(/\/$/, '');
  return first.origin === second.origin && path(first) === path(second) && first.search === second.search;
}
