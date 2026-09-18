import { useEffect, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import type { SessionView, WorldView } from '../../contracts/src/session.ts';

export const frameUrl = (world: WorldView) => `/api/frame/${encodeURIComponent(world.id)}?v=${world.frameVersion}`;

/** Only authoritative lifecycle stages drive automatic camera changes. */
export function directorWorlds(session: SessionView): WorldView[] {
  const ids = session.directorWorldIds ?? session.comparison?.candidateIds;
  if (ids?.length) return ids.flatMap(id => { const world = session.worlds.find(w => w.id === id); return world ? [world] : []; });
  const experiments = session.worlds.filter(w => w.role === 'experiment');
  if (experiments.length) return experiments;
  return [];
}

function outcome(world: WorldView, session: SessionView) {
  if (world.thinking) return 'choosing next approach…';
  if (!world.state.alive) return 'died · final frame';
  if (world.role === 'archived') return 'not selected · final frame';
  if (world.id === session.mainId) return `main session · ${session.stage === 'deciding' ? 'choosing next move' : world.status}`;
  if (world.trial && world.trial.elapsed >= world.trial.total) return session.stage === 'choosing' ? 'judging' : 'ready for judging';
  return world.status === 'running' ? 'exploring' : 'paused';
}

export function Director({ session, onFocus, phaseTitle, phaseDetail }: { session: SessionView; onFocus: (id: string) => void; now: number; phaseTitle: string; phaseDetail: string }) {
  const worlds = directorWorlds(session);
  const main = session.worlds.find(world => world.id === session.mainId);
  const mainIsSource = worlds.some(world => world.role === 'experiment' && world.parentId === session.mainId);
  const cards = main && !worlds.some(world => world.id === main.id) ? [main, ...worlds] : worlds;
  const [columns, setColumns] = useState(() => { const saved = Number(localStorage.getItem('mom-grid-columns')); return [1, 2, 3].includes(saved) ? saved : 2; });
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem('mom-grid-autoscroll') === 'true');
  const grid = useRef<HTMLDivElement>(null);
  const lastInteraction = useRef(0);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setOverflows(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [cards.length, columns]);
  useEffect(() => { localStorage.setItem('mom-grid-autoscroll', String(autoScroll)); }, [autoScroll]);
  useEffect(() => {
    if (!autoScroll) return;
    const timer = setInterval(() => {
      const element = grid.current;
      if (!element || document.hidden || element.matches(':hover') || element.contains(document.activeElement)
        || Date.now() - lastInteraction.current < 8000 || element.scrollHeight <= element.clientHeight + 1) return;
      const bottom = element.scrollHeight - element.clientHeight;
      element.scrollTo({ top: element.scrollTop >= bottom - 2 ? 0 : Math.min(bottom, element.scrollTop + element.clientHeight),
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, 6000);
    return () => clearInterval(timer);
  }, [autoScroll]);
  const batch = cards.map(w => w.id).join(',');
  useEffect(() => { grid.current?.scrollTo({ top: 0 }); }, [batch, columns]);
  useEffect(() => { localStorage.setItem('mom-grid-columns', String(columns)); }, [columns]);
  const continuing = worlds.some(w => w.id === session.mainId);
  const source = session.worlds.find(w => w.id === (worlds[0]?.parentId ?? session.mainId));
  const limit = session.decision?.futureLimit ?? session.maxFutures ?? 4;
  const trials = worlds.filter(world => world.trial && world.trial.total > 0);
  const trialTicks = trials.reduce((sum, world) => sum + world.trial!.total, 0);
  const exploredTicks = trials.reduce((sum, world) => sum + (!world.state.alive || world.role === 'archived'
    ? world.trial!.total : Math.min(world.trial!.total, Math.max(0, world.trial!.elapsed))), 0);
  const progress = trialTicks ? exploredTicks / trialTicks : undefined;
  return <div className={`director ${continuing ? 'continuing' : ''}`}>
    <div className="director-heading">
      <div className="director-phase">
        <div className="director-title" title={`Maximum ${limit} parallel futures. Available approaches depend on the current game state.`}>
          <span className={`director-status-dot ${session.running ? 'active' : ''}`} aria-hidden="true" />
          <h2>{session.error ? 'Run paused' : phaseTitle}</h2>
        </div>
        <p>{session.error ? 'Resolve the session error before resuming play.' : phaseDetail}</p>
      </div>
      <div className="director-tools">
        <details className="director-layout" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary aria-label="Futures layout settings" title="Layout settings"><LayoutGrid size={17} aria-hidden="true" /></summary>
          <div className="director-layout-panel">
            <label className="grid-layout"><span>Columns</span><select aria-label="Futures grid columns" value={columns} onChange={e => setColumns(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n} value={n}>{n} {n === 1 ? 'column' : 'columns'}</option>)}</select></label>
            {overflows && <label className="grid-auto-scroll" title="Scroll every 6 seconds; pauses while you interact with the grid"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} /> Auto-scroll extra futures</label>}
          </div>
        </details>
      </div>
    </div>
    <div ref={grid} className="director-grid" data-columns={columns} aria-label="Live futures" tabIndex={0} onWheel={() => { lastInteraction.current = Date.now(); }} onPointerDown={() => { lastInteraction.current = Date.now(); }} style={{ '--columns': columns, '--rows': Math.min(2, Math.max(1, Math.ceil(cards.length / columns))) } as React.CSSProperties}>
      {!worlds.length && <div className="director-wait" role="status">Capturing the starting world and creating independent sandboxes…</div>}
      {cards.map(world => <button key={world.id} className={`future-screen ${world.id === session.mainId ? 'main-session' : ''} ${world.id === session.mainId || session.comparison?.bestId === world.id ? 'winner' : ''} ${!world.state.alive ? 'failed' : ''}`} onClick={() => onFocus(world.id)} aria-label={world.id === session.mainId ? `Inspect main session: ${world.label}` : `Inspect future ${worlds.findIndex(candidate => candidate.id === world.id) + 1}: ${world.label}`} aria-current={world.id === session.mainId ? 'true' : undefined}>
        <img src={frameUrl(world)} alt={`${world.label} ${world.status === 'running' ? 'live gameplay' : 'final or paused frame'}`} />
        <div className="future-heading"><strong title={world.plan?.label ?? world.label}>{world.id === session.mainId && <b className="main-session-badge">Main session</b>}{world.plan?.label ?? world.label}</strong><span>{world.id === session.mainId && mainIsSource ? `Starting point for these futures · ${world.status}` : outcome(world, session)}</span><div className="future-stats"><span>health {world.state.health}</span><span>{world.state.kills} kills</span></div></div>

      </button>)}
    </div>
    <div className="director-bottom">
    {source && <details className="director-start"><summary>Starting point</summary><div className="director-start-content"><img src={frameUrl(source)} alt="Source world's latest frame" /><span>Source world · {source.label}<small>Latest source frame; this world may have continued since the fork.</small></span></div></details>}
        {progress !== undefined && <span className="director-progress-text" title="Completed trial time across all futures. Ended futures count as complete; comparison follows when every future finishes.">Trials {Math.round(progress * 100)}% complete</span>}
    </div>
  </div>;
}
