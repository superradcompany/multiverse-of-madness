import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChessComparisonView } from '../../../examples/chess/comparison-view.ts';
import { Board, MoveList } from './chess-board.tsx';

export function ChessLearningComparison({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<ChessComparisonView>(), [error, setError] = useState('');
  const [follow, setFollow] = useState(true), [scenario, setScenario] = useState(''), [position, setPosition] = useState(0);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/chess/learning-comparison'), value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Comparison unavailable');
        if (!stopped) { setView(value); setError(''); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Comparison unavailable'); }
      finally { if (!stopped && follow) timer = setTimeout(poll, 500); }
    };
    if (follow) void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [follow]);
  const active = view?.runs.find(run => run.status === 'running') ?? view?.runs.findLast(run => run.status !== 'waiting');
  const selected = !follow && view?.runs.some(run => run.scenarioId === scenario) ? scenario : active?.scenarioId ?? view?.runs[0]?.scenarioId;
  const pair = view?.runs.filter(run => run.scenarioId === selected) ?? [];
  const last = Math.max(0, ...pair.map(run => run.frames.length - 1)), index = follow ? last : Math.min(position, last);
  const seek = (index: number) => { setScenario(selected ?? ''); setPosition(index); setFollow(false); setReplaying(false); };
  useEffect(() => {
    if (!replaying) return;
    if (position >= last) { setReplaying(false); return; }
    const timer = setTimeout(() => setPosition(value => value + 1), 800);
    return () => clearTimeout(timer);
  }, [replaying, position, last]);
  return <section className="learning-comparison" aria-label="Learning comparison">
    <div className="comparison-heading"><div><h2>{view?.status === 'running' ? 'Testing strategies' : 'Recorded comparison'}</h2><p className="hint">Same starting board. Runs execute one at a time; your live game is separate.</p></div><button onClick={onClose}><ArrowLeft />Back to game</button></div>
    {error && <p role="alert" className="error">{error}</p>}
    {!view ? <p role="status">Loading recorded positions…</p> : <>
      <div className="comparison-controls"><label>Test position <select aria-label="Comparison test position" value={selected} onChange={event => { setScenario(event.target.value); setPosition(0); setFollow(false); setReplaying(false); }}>
        {view.runs.filter(run => run.role === 'baseline').map(run => <option key={run.scenarioId} value={run.scenarioId}>{run.label}</option>)}
      </select></label><span className="hint">{view.runs.filter(run => run.status === 'complete').length}/{view.runs.length} runs finished</span>
        <button disabled={last === 0} onClick={() => { if (replaying) setReplaying(false); else { seek(index >= last ? 0 : index); setReplaying(true); } }}>{replaying ? 'Pause replay' : 'Play replay'}</button>
        {view.status === 'running' && <button aria-pressed={follow} onClick={() => { setReplaying(false); setFollow(true); }}>{follow ? 'Following live test' : 'Follow live test'}</button>}</div>
      <div className="comparison-boards">{pair.map(run => {
        const state = run.frames[follow ? run.frames.length - 1 : Math.min(index, run.frames.length - 1)]!;
        return <article className="comparison-board" key={run.role}>
          <div className="card-heading"><div><h3>{view.kind === 'audit' ? run.role === 'baseline' ? 'Previous strategy' : 'Current strategy' : run.role === 'baseline' ? 'Current strategy' : 'Proposed strategy'}</h3>
            <span className="hint">{run.status === 'complete' ? 'Finished' : run.status === 'running' ? run.trials.length ? `Testing ${run.trials.length} futures` : 'Playing' : run.status === 'waiting' ? view.status === 'running' ? 'Waiting its turn' : 'Not run' : 'Stopped before completion'}</span></div>
            {run.value !== undefined && <span className="comparison-value">Final score {run.value > 0 ? '+' : ''}{run.value}</span>}</div>
          <Board state={state} /><MoveList moves={state.moves} />
          <p className="hint">{state.ply - run.frames[0]!.ply} selected half-moves{run.attemptedPlies > 0 ? ` · ${run.attemptedPlies} explored` : ''}</p>
          {follow && run.trials.length > 0 && <details className="comparison-trials"><summary>Futures being tested</summary><div>{run.trials.map((trial, index) => <figure key={index}><Board state={trial.state} /><figcaption>{trial.label}</figcaption></figure>)}</div></details>}
        </article>;
      })}</div>
      <div className="replay-controls"><button aria-label="Previous comparison move" disabled={index === 0} onClick={() => seek(index - 1)}><ChevronLeft /></button>
        <label><span>{follow && view.status === 'running' ? 'Following the latest selected paths' : `Recorded position ${index + 1} of ${last + 1}`}</span><input aria-label="Comparison replay position" type="range" min={0} max={last} value={index} onChange={event => seek(Number(event.target.value))} /></label>
        <button aria-label="Next comparison move" disabled={index >= last} onClick={() => seek(index + 1)}><ChevronRight /></button></div>
      {view.reason && <p className="comparison-result">{friendlyReason(view.reason)}</p>}
      {view.summary && <details><summary>Why this result</summary>{view.summary.positions.map((item, index) => <p className="hint" key={index}>Position {index + 1}: {item.improved} better, {item.tied} tied, {item.worse} worse.{item.mean !== undefined && <> Average change versus baseline: {item.mean > 0 ? '+' : ''}{item.mean.toFixed(2)} score points.</>}</p>)}<p className="hint">Scores measure changes in piece values and checkmate; higher is better. These short tests are not a chess-strength rating. The final scores use the same move horizon.</p></details>}
    </>}
  </section>;
}

function friendlyReason(reason: string) {
  if (reason === 'Candidate met the fixed acceptance contract on every required scenario') return 'The tested strategy passed these comparison checks.';
  if (reason === 'Repeated comparisons did not demonstrate the required improvement at every position') return 'The tested strategy did not improve consistently across all positions.';
  if (reason === 'Candidate exceeded the allowed regression on a scenario') return 'The tested strategy performed worse at one or more positions.';
  if (reason === 'Candidate did not reach the required mean improvement') return 'The overall gains were too small to establish an improvement.';
  if (/did not complete|did not reach the required selected-path horizon/.test(reason)) return 'Some runs did not finish. This comparison cannot establish an improvement.';
  return reason;
}
