import { GameSessionMenu } from './game-session-menu.tsx';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChessWebView } from '../../../examples/chess/web-controller.ts';
import type { ChessState } from '../../../examples/chess/runtime.ts';
import { Play, Pause, SkipForward, History, ArrowLeft, ChevronLeft, ChevronRight, Brain, RotateCcw } from 'lucide-react';
import { Board, MoveList } from './chess-board.tsx';
import { ChessLearningComparison } from './chess-learning-comparison.tsx';
import './chess.css';

async function get<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options), value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed'); return value as T;
}
function App() {
  const [view, setView] = useState<ChessWebView>(), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [guide, setGuide] = useState(''), [frame, setFrame] = useState<ChessState>(), [index, setIndex] = useState(0), [frames, setFrames] = useState(0);
  const [focusedWorld, setFocusedWorld] = useState('');
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const replayRequest = useRef(0), replayEndpoint = useRef('');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await get<ChessWebView>('/api/chess'); if (!stopped) setView(next); }
      catch (e) { if (!stopped) setError(String(e)); }
      finally { if (!stopped) timer = setTimeout(poll, 500); }
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  async function command(input: object) {
    setPending(true); setError('');
    try { setView(await get<ChessWebView>('/api/chess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setPending(false); }
  }
  async function replay(position: number) {
    const request = ++replayRequest.current;
    try { const result = await get<{ state: ChessState }>(`/api/chess/frame?index=${position}&endpoint=${encodeURIComponent(replayEndpoint.current)}`); if (request === replayRequest.current) { setFrame(result.state); setIndex(position); } }
    catch (e) { if (request === replayRequest.current) setError(String(e)); }
  }
  async function openReplay(endpoint?: string) {
    setComparisonOpen(false);
    try { const path = await get<{ frames: number; endpointId: string }>(`/api/chess/replay${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`); replayEndpoint.current = path.endpointId; setFrames(path.frames); if (path.frames) await replay(path.frames - 1); }
    catch (e) { setError(String(e)); }
  }
  const main = view?.worlds.find(world => world.id === view.mainId), idle = view && !view.running && !view.busy && !pending;
  const terminal = Boolean(main && main.state.status !== 'ongoing' && !view?.comparison);
  const activeWorld = view?.worlds.some(world => world.id === focusedWorld) ? focusedWorld : view?.mainId;
  const isPlaying = Boolean(view?.running || view?.busy);
  const returnToLive = () => { replayRequest.current++; setFrame(undefined); };
  async function newGame() {
    if (view && await command({ type: 'new-game', expectedMainId: view.mainId })) {
      returnToLive(); setComparisonOpen(false); setFocusedWorld('');
    }
  }
  return <div className="chess-app">
    <header className="app-header">
      <div className="brand"><p className="eyebrow">multiverse of madness</p><div className="title-line"><h1>Chess</h1><span className="model-badge">{view?.model === 'chess-jev' ? 'Jev' : view ? 'Test player' : 'Connecting'}</span><GameSessionMenu game="chess" label="Chess" /></div></div>
      <div className="controls">
        <button disabled={!view} onClick={() => { setComparisonOpen(false); frame ? returnToLive() : void openReplay(); }}>{frame ? <ArrowLeft /> : <History />}<span>{frame ? 'Live' : 'Replay'}</span></button>
        <button disabled={!idle || Boolean(frame) || terminal} onClick={() => void command({ type: 'step' })}><SkipForward /><span>{view?.comparison?.complete ? 'Continue' : 'Next move'}</span></button>
        {terminal && !isPlaying ? <button className="primary" disabled={!idle} onClick={() => void newGame()}><RotateCcw /><span>New game</span></button>
          : <button className="primary" disabled={pending || !view || (Boolean(frame) && !isPlaying)} onClick={() => void command({ type: isPlaying ? 'pause' : 'play' })}>{isPlaying ? <Pause /> : <Play />}<span>{isPlaying ? 'Pause' : 'Play'}</span></button>}
      </div>
    </header>
    {(error || view?.error) && <p role="alert" className="error">{error || view?.error}</p>}
    {!view || !main ? <p role="status">Connecting to chess…</p> : <>
      <dl className="run-stats">
        <div><dt>Moves played</dt><dd>{main.state.ply}</dd></div><div><dt>Moves explored</dt><dd>{view.attempts.plies}</dd></div>
        <div><dt>Comparisons</dt><dd>{view.attempts.forks}</dd></div><div><dt>Remembered outcomes</dt><dd>{view.experienceCount}</dd></div>
      </dl>
      <div className="layout"><main className="chess-stage">
        {!comparisonOpen && <div className="phase"><div className="phase-heading"><span className={`status-dot ${view.running ? 'active' : ''}`} /><h2>{frame ? 'Replay' : view.busy ? 'Jev is exploring the next move' : view.comparison?.complete ? 'Compare the alternatives' : main.state.status !== 'ongoing' ? main.state.status === 'draw' ? 'Draw' : 'Checkmate' : view.running ? 'Playing' : 'Paused'}</h2></div>
          <p>{frame ? `Recorded position after ${frame.ply} moves. ${view.running ? 'Live play continues in the background.' : 'Your live session stays where you left it.'}` : view.comparison ? `${view.worlds.length - 1} futures, one starting board. Continue with the best measured outcome.` : terminal ? 'Game finished. Start a new game, replay this run or restore a checkpoint. Your goal and learned strategy carry forward.' : `${main.state.turn === 'w' ? 'White' : 'Black'} to move. White pursues your goal; Black plays against it.`}</p></div>}
        {comparisonOpen ? <ChessLearningComparison onClose={() => setComparisonOpen(false)} /> : frame ? <section className="replay">
          <div className="replay-board"><Board state={frame} /></div>
          <div className="replay-controls"><button aria-label="Previous recorded move" disabled={index === 0} onClick={() => void replay(index - 1)}><ChevronLeft /></button>
            <label><span>Position {index + 1} of {frames}</span><input aria-label="Replay position" type="range" min={0} max={Math.max(0, frames - 1)} value={index} onChange={e => void replay(Number(e.target.value))} /></label>
            <button aria-label="Next recorded move" disabled={index >= frames - 1} onClick={() => void replay(index + 1)}><ChevronRight /></button>
          </div><MoveList moves={frame.moves} /><button className="return-live" onClick={returnToLive}><ArrowLeft />Return to live</button>
        </section> : <>
          {view.worlds.length > 1 && <nav className="board-switcher" aria-label="Choose board">{view.worlds.map((world, i) => <button key={world.id} aria-pressed={world.id === activeWorld} onClick={() => setFocusedWorld(world.id)}>{world.id === view.mainId ? 'Main' : `Future ${i}`}</button>)}</nav>}
          <div className="boards" data-count={view.worlds.length}>{view.worlds.map(world => <article key={world.id} data-focused={world.id === activeWorld} className={`board-card ${world.id === view.mainId ? 'main-board' : ''}`}>
            <div className="card-heading"><div><span className="card-role">{world.id === view.mainId ? 'Main session' : 'Alternate future'}</span><h3>{world.id === view.mainId ? 'Current position' : world.label}</h3></div><span className={`turn-badge ${world.state.turn === 'w' ? 'white-turn' : ''}`}>{world.state.status === 'ongoing' ? `${world.state.turn === 'w' ? 'White' : 'Black'} to move` : world.state.status}</span></div>
            <Board state={world.state} /><MoveList moves={world.state.moves} />
          </article>)}</div>
        </>}
      </main><aside className="chess-sidebar">
        {Boolean(view.completedGames?.length) && <section><details><summary>Previous games <span>{view.completedGames.length}</span></summary>{[...view.completedGames].reverse().map((game, index) => <div className="checkpoint" key={game.endpointId}><span>Game {view.completedGames.length - index} · {game.status} · {game.plies} half-moves</span><button onClick={() => void openReplay(game.endpointId)}>Replay</button></div>)}</details></section>}
        {view.learning && <section className="chess-learning"><div className="learning-heading"><h2><Brain aria-hidden="true" /> Background learning</h2><label><input type="checkbox" aria-label="Enable background learning" checked={view.learning.enabled} disabled={pending} onChange={e => void command({ type: 'learning', enabled: e.target.checked })} />{view.learning.enabled ? 'On' : 'Off'}</label></div>
          <p className="learning-stage">{view.learning.stage === 'testing' && ['evaluating', 'pending'].includes(view.learning.audit?.status ?? '') ? 'Checking the current strategy against its predecessor' : { off: 'Learning is paused', watching: 'Watching for repeated problems', reviewing: 'Codex is reviewing recent play', testing: 'Testing a proposed strategy', ready: 'Ready for the next safe moment' }[view.learning.stage] ?? view.learning.stage}</p>
          {view.learning.elapsedSeconds !== undefined && <p className="hint">{Math.floor(view.learning.elapsedSeconds / 60)}m {view.learning.elapsedSeconds % 60}s elapsed · You can keep playing.</p>}
          <p className="hint">Strategy revision {view.learning.revision}. Jev keeps choosing moves while the supervisor works separately.</p>
          {view.learning.comparison && <button className="watch-comparison" onClick={() => setComparisonOpen(true)}><History aria-hidden="true" />{view.learning.comparison.status === 'running' ? 'Watch comparison' : 'Replay comparison'}</button>}
          {view.learning.error && <p role="alert">{view.learning.error}</p>}
          {view.learning.audit && <details open={view.learning.audit.status === 'rolled-back'}><summary>Strategy check</summary><p>{view.learning.audit.reason}</p>{view.learning.audit.summary && <><p>{view.learning.audit.summary.completedPairs}/{view.learning.audit.summary.plannedPairs} paired runs complete</p>{view.learning.audit.summary.positions.map((position, index) => <p className="hint" key={index}>Position {index + 1}: {position.mean === undefined ? 'incomplete' : `mean gain ${position.mean.toFixed(2)}, range ${position.min} to ${position.max}`}. {position.improved} better · {position.tied} tied · {position.worse} worse.{position.baseline && position.candidate && <> Average outcome change: previous {position.baseline.mean.toFixed(2)}, current {position.candidate.mean.toFixed(2)}.</>}</p>)}<p className="hint">Small samples show variability, not a chess-strength rating.</p></>}{view.learning.audit.status === 'rolled-back' && <p className="hint">The board and move history are preserved. The next move uses the previous strategy.</p>}</details>}
          {(view.learning.reason || view.learning.lastOutcome) && <details><summary>Latest review</summary>{view.learning.reason && <p>{view.learning.reason}</p>}{view.learning.lastOutcome && <p>{view.learning.lastOutcome.status === 'activated' ? (view.learning.lastOutcome.active === false ? 'This proposal was applied earlier and is no longer in use.' : 'Applied a tested improvement.') : view.learning.lastOutcome.status === 'rejected' ? 'Kept the current strategy: the candidate did not pass comparison.' : `Review result: ${view.learning.lastOutcome.status}.`}</p>}{view.learning.lastOutcome?.reason && <p className="hint">{view.learning.lastOutcome.reason}</p>}</details>}
        </section>}
        <section className="goal-card"><h2>Your goal</h2><p className="objective">{view.objective}</p><details><summary>Edit guidance</summary><form onSubmit={e => { e.preventDefault(); void command({ type: 'guide', text: guide }).then(ok => { if (ok) setGuide(''); }); }}><textarea aria-label="Your chess goal" value={guide} onChange={e => setGuide(e.target.value)} placeholder="What should White aim for?" maxLength={2000} /><button disabled={!idle || !guide.trim()}>Update goal</button></form><p className="hint">{view.model === 'chess-jev' ? 'Pause before editing. Jev receives this goal at each decision.' : 'The deterministic test player does not interpret guidance.'}</p></details></section>
        <section><details><summary>Checkpoints <span>{view.checkpoints.length} saved</span></summary>{view.checkpoints.length ? view.checkpoints.map(point => <div className="checkpoint" key={point.id}><span>After {point.ply} moves</span><button disabled={!idle || Boolean(frame)} onClick={() => void command({ type: 'rollback', id: point.id })}>Restore</button></div>) : <p>Saved automatically as play progresses.</p>}<p className="hint">Restoring preserves remembered attempts. Refresh keeps your session.</p></details></section>
        <section><details><summary>How it works</summary><p>Below {Math.round(view.policy.threshold * 100)}% confidence, White tests up to {view.policy.breadth} legal moves across {view.policy.trialPlies} half-moves. A half-move is one turn by either side.</p><p>Outcomes use material balance and checkmate. This is a basic evaluator, not a chess-strength benchmark.</p><p className="hint">Exact board histories run locally. {view.learning ? 'Strategy code runs in isolated VMs; background changes must pass a separate comparison before use.' : 'This session uses Jev without a background supervisor.'}</p></details></section>
      </aside></div>
    </>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
