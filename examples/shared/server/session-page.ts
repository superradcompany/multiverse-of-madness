import type { SessionView } from './session-registry.ts';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Server-rendered forms work without a JavaScript bundle or a running game. */
export function sessionPage(sessions: SessionView[], csrf: string, notice = '', watching?: string): string {
  const pending = sessions.some(session => session.id === watching && ['starting', 'stopping'].includes(session.status));
  const hidden = (action: string, id?: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="${action}">${id ? `<input type="hidden" name="id" value="${id}">` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  ${pending ? '<meta http-equiv="refresh" content="3">' : ''}<title>Games & sessions</title>
  <link rel="stylesheet" href="/sessions.css"></head><body><main>
  <header><div><p class="eyebrow">multiverse of madness</p><h1>Games & sessions</h1><p>Separate runs. Their own settings, learning history and replays.</p></div><a class="button" href="/">Refresh</a></header>
  ${notice ? `<p class="notice" role="alert">${escape(notice)}</p>` : ''}
  <section class="create"><h2>New session</h2><form method="post" action="/">${hidden('create')}
  <label>Name<input name="title" maxlength="80" required placeholder="My next run" autocomplete="off"></label>
  <div class="field"><label for="game">Game</label><select name="game" id="game"><option value="doom">Doom</option><option value="chess">Chess</option></select></div>
  <label class="check"><input type="checkbox" name="learning" value="true">Enable chess background learning</label>
  <button type="submit">Create session</button></form><p class="hint">Creation only saves the session. Start its backend when ready, then press Play in the game. Enable Doom learning in its gameplay settings.</p></section>
  <section aria-label="Saved sessions" class="sessions">${sessions.length ? sessions.map(session => `<article>
    <div class="session-title"><div><p class="eyebrow">${session.game === 'doom' ? 'Doom' : 'Chess'}${session.learning ? ' · background learning' : ''}</p><h2>${escape(session.title)}</h2></div><span class="status">${escape(session.status === 'ready' ? 'Backend ready' : session.status === 'unavailable' ? 'Owner unavailable' : session.status)}</span></div>
    <div class="actions">${session.status === 'ready' ? `<a class="button primary" href="${escape(session.url)}">Open game</a><form method="post" action="/">${hidden('stop', session.id)}<button>Stop backend</button></form>` : session.status === 'stopped' ? `<form method="post" action="/">${hidden('start', session.id)}<button class="primary">Start backend</button></form>` : `<a class="button" href="/?watch=${session.id}">Check status</a>`}
    <details><summary>Rename</summary><form method="post" action="/">${hidden('rename', session.id)}<label>Session name<input name="title" value="${escape(session.title)}" maxlength="80" required></label><button>Save name</button></form></details></div>
    <p class="hint">${session.status === 'stopped' ? 'Saved locally. Starting reopens this run.' : session.status === 'starting' ? 'Opening the saved run. This page checks again in a few seconds.' : session.status === 'unavailable' ? 'The port is occupied or the backend cannot be verified. No other process will be stopped or replaced.' : session.status === 'stop-failed' ? 'The backend could not finish saving and stopping. Inspect its host.log before retrying.' : 'Switching views keeps this run and its history.'}</p>
  </article>`).join('') : '<p class="empty">No sessions yet. Create your first run above.</p>'}</section>
  <footer>Closing this page or the sessions manager leaves game backends running. Stop each backend here when finished. Doom keeps its detached VM and saved checkpoints for reconnection; stopping the backend does not delete them.</footer>
  </main></body></html>`;
}
