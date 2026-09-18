import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Gamepad2, X, ArrowUpRight, Check } from 'lucide-react';
import { localGameSessions, sameSessionUrl, type GameSessionLink } from './game-sessions.ts';
import './game-session-menu.css';

declare const __GAME_SESSIONS__: GameSessionLink[] | null;
export function GameSessionMenu({ game, label }: { game: string; label: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = window.location.href, configured = __GAME_SESSIONS__ ?? localGameSessions(current);
  const sessions = configured.some(session => sameSessionUrl(session.url, current)) ? configured : [
    { id: 'current-session', game, gameLabel: label, title: 'Current run', description: 'The session you are viewing.', url: current }, ...configured,
  ];
  const groups = [...new Set(sessions.map(session => session.game))];
  return <>
    <button className="game-session-trigger" title="Choose game or session" aria-label="Choose game or session" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}><Gamepad2 aria-hidden="true" /></button>
    {createPortal(<dialog ref={dialog} className="game-session-dialog" aria-labelledby="game-session-heading" onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.current?.close();
    }}>
      <div className="game-session-heading"><div><h2 id="game-session-heading">Games & sessions</h2><p>Choose a run to view.</p></div><button autoFocus aria-label="Close game selector" onClick={() => dialog.current?.close()}><X /></button></div>
      <nav aria-label="Game sessions">{groups.map(group => <section key={group} className="game-session-group"><h3>{sessions.find(session => session.game === group)!.gameLabel}</h3>
        {sessions.filter(session => session.game === group).map(session => { const selected = sameSessionUrl(session.url, current); return <a key={session.id} href={session.url} aria-current={selected ? 'page' : undefined} onClick={selected ? event => { event.preventDefault(); dialog.current?.close(); } : undefined}>
          <div><strong>{session.title}</strong><span>{session.description}</span></div><small>{selected ? 'Viewing' : 'Open'}</small>{selected ? <Check aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
        </a>; })}</section>)}</nav>
      <p className="game-session-note">Switching views keeps each run and its replay history. Games already playing continue in the background.</p>
    </dialog>, document.body)}
  </>;
}
