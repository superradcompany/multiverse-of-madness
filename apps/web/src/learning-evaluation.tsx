import { useEffect, useState } from 'react';
import type { EvaluationRunPreview, LearningEvaluationView } from '../../../packages/contracts/src/learning-evaluation.ts';

export function LearningEvaluation({ proposalId }: { proposalId: string }) {
  const [data, setData] = useState<LearningEvaluationView>(), [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch('/api/learning/evaluations/' + proposalId, { signal: abort.signal });
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Could not load comparison');
        if (!stopped) { setData(value); setError(''); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : String(error)); }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    };
    setData(undefined); setSelected(undefined); void poll();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [proposalId]);
  const current = data?.runs.find(run => run.status === 'running');
  const lastStarted = data?.runs.filter(run => run.status !== 'waiting' && run.status !== 'not-run').at(-1);
  const scenario = selected ?? current?.scenarioId ?? lastStarted?.scenarioId ?? data?.scenarios[0];
  return <section className="evaluation-preview" aria-label="Gameplay comparison">
    <div className="evaluation-toolbar"><strong>{data?.total ? `${data.finished} / ${data.total} runs finished` : data && !data.active ? 'No evaluation games were started' : 'Preparing test games…'}</strong>
      {data && data.scenarios.length > 0 && <select aria-label="Comparison scenario" value={selected ?? 'follow'} onChange={event => setSelected(event.target.value === 'follow' ? undefined : event.target.value)}>
        <option value="follow">Follow comparison</option>{data.scenarios.map((id, index) => <option key={id} value={id}>{id === 'saved-stuck-position' ? 'Saved stuck position' : `Start ${index + 1}`}</option>)}
      </select>}
    </div>
    {data?.total ? <><progress aria-label="Evaluation run progress" value={data.finished} max={data.total} />
      <p className="evaluation-caption">{scenario === 'saved-stuck-position' ? 'Testing from the saved stuck position' : `Start ${data.scenarios.indexOf(scenario!) + 1} of ${data.scenarios.length}`} · runs execute one at a time under matching test limits.</p>
      <div className="evaluation-pair">{data.runs.filter(run => run.scenarioId === scenario).map(run => <RunPreview key={run.id} run={run} />)}</div>
      <small className="evaluation-caption">Saved gameplay previews update as test runs advance. Completed runs show their last captured frame. Your main session stays separate.</small>
    </> : null}
    {error && <p role="alert" className="skill-error">{error}</p>}
  </section>;
}
const labels: Record<EvaluationRunPreview['status'], string> = {
  waiting: 'Waiting for its turn', running: 'Running', complete: 'Finished', error: 'Failed',
  cancelled: 'Cancelled', timeout: 'Timed out', interrupted: 'Interrupted', 'not-run': 'Not run',
};
function RunPreview({ run }: { run: EvaluationRunPreview }) {
  const [worldId, setWorldId] = useState<string>();
  const world = run.worlds.find(world => world.id === worldId) ?? run.worlds.find(world => world.role === 'main') ?? run.worlds[0];
  const stats = run.stats;
  return <article className="evaluation-run">
    <div className="evaluation-run-heading"><strong>{run.role === 'baseline' ? 'Current strategy' : 'Proposed improvement'}</strong><span className={run.status === 'running' ? 'evaluation-running' : ''}>{labels[run.status]}</span></div>
    <div className="evaluation-screen">{world?.frame ? <img src={'/api/learning/evaluation-frames/' + world.frame} alt={`${run.role === 'baseline' ? 'Current' : 'Proposed'} strategy, ${world.label}, saved tick ${world.tick}`} /> : <span>{run.status === 'running' ? 'Starting the game…' : labels[run.status]}</span>}</div>
    {world && <div className="evaluation-world"><span>{world.role === 'main' ? 'Selected route' : 'Trial future'} · {world.label}</span><small>tick {world.tick}</small></div>}
    {run.worlds.length > 1 && <select aria-label={`${run.role} preview world`} value={world?.id ?? ''} onChange={event => setWorldId(event.target.value)}>{run.worlds.map(world => <option key={world.id} value={world.id}>{world.role === 'main' ? 'Selected route' : 'Future'} · {world.label}</option>)}</select>}
    {run.options && <details className="evaluation-options" open={run.role === 'candidate'}><summary>Options ranked by Jev</summary>
      <ul>{run.options.entries.map(option => <li key={option.label}><span>{option.label}</span><small>{Math.round(option.probability * 100)}%{option.tested ? ' · tested' : ''}</small></li>)}</ul>
    </details>}
    {stats && <dl className="evaluation-stats"><div><dt>Route kills</dt><dd>{stats.kills}</dd></div><div><dt>Health</dt><dd>{stats.health}</dd></div><div><dt>Areas</dt><dd>{stats.cells}</dd></div><div><dt>Gameplay</dt><dd>{stats.seconds.toFixed(1)}s</dd></div></dl>}
    {world?.role === 'experiment' && <small>Trial: {world.health} health · {world.kills} map kills</small>}
    {run.metrics?.score !== undefined && <p className="evaluation-score">Final score <strong>{run.metrics.score}</strong></p>}
    <small className="evaluation-caption">{run.updatedAt ? `Frame saved ${new Date(run.updatedAt).toLocaleTimeString()}` : 'No captured frame yet'}{run.status === 'running' && run.stage ? ` · ${run.stage === 'error' ? 'finishing run' : run.stage}` : ''}</small>
    {run.error && <p className="skill-error">{run.error}</p>}
  </article>;
}
