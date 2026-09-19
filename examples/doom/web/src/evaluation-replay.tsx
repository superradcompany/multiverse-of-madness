import { useEffect, useRef, useState } from 'react';
import type { EvaluationReplayFrame, EvaluationReplaySummary } from '../../contracts/src/learning-evaluation.ts';

/** Each instance owns a small playback cache, separate from the live session. */
export function EvaluationReplay({ proposalId, runId, summary }: {
  proposalId: string; runId: string; summary: EvaluationReplaySummary;
}) {
  const [index, setIndex] = useState(0), [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<EvaluationReplayFrame>(), [error, setError] = useState('');
  const batches = useRef(new Map<number, Promise<EvaluationReplayFrame[]>>());
  const requests = useRef<AbortController | undefined>(undefined);
  const anchor = useRef<{ at: number; tick: number } | undefined>(undefined);
  const ready = frame?.index === index;

  useEffect(() => {
    const controller = new AbortController(); requests.current = controller;
    batches.current.clear(); anchor.current = undefined;
    setIndex(0); setFrame(undefined); setPlaying(false); setError('');
    return () => { controller.abort(); batches.current.clear(); };
  }, [proposalId, runId]);

  useEffect(() => {
    const controller = requests.current;
    if (!controller) return;
    let cancelled = false;
    const load = (start: number) => {
      let pending = batches.current.get(start);
      if (!pending) {
        pending = fetch(`/api/learning/evaluations/${proposalId}/replays/${runId}?start=${start}&count=35`, { signal: controller.signal })
          .then(async response => {
            if (!response.ok) throw new Error('Recording unavailable. It may have been removed.');
            return response.json() as Promise<EvaluationReplayFrame[]>;
          });
        batches.current.set(start, pending);
        while (batches.current.size > 4) batches.current.delete(batches.current.keys().next().value!);
        void pending.catch(() => { if (batches.current.get(start) === pending) batches.current.delete(start); });
      }
      return pending;
    };
    const start = Math.floor(index / 35) * 35;
    setError('');
    void load(start).then(async frames => {
      const value = frames.find(item => item.index === index);
      if (!value) throw new Error('Recorded frame is missing');
      const image = new Image(); image.src = `data:image/png;base64,${value.frame}`;
      await image.decode();
      if (!cancelled) {
        setFrame(value);
        if (start + 35 < summary.frames) void load(start + 35).catch(() => {});
      }
    }).catch(error => {
      if (!cancelled) { setError(error instanceof Error ? error.message : 'Playback failed'); setPlaying(false); anchor.current = undefined; }
    });
    return () => { cancelled = true; };
  }, [proposalId, runId, index, summary.frames]);

  useEffect(() => {
    if (!playing || !ready || !frame) return;
    if (index >= summary.frames - 1) { setPlaying(false); anchor.current = undefined; return; }
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    anchor.current ??= { at: performance.now(), tick: frame.tick };
    const clock = anchor.current;
    const nextBatch = batches.current.get(Math.floor((index + 1) / 35) * 35);
    if (!nextBatch) { setIndex(index + 1); return; }
    void nextBatch.then(frames => {
      const next = frames.find(item => item.index === index + 1);
      if (!next) throw new Error('Recorded frame is missing');
      if (cancelled) return;
      timer = setTimeout(() => setIndex(index + 1), Math.max(0, clock.at + (next.tick - clock.tick) * 1000 / 35 - performance.now()));
    }).catch(() => {
      if (!cancelled) { setPlaying(false); setError('Could not load the next recorded frames. Seek to retry.'); anchor.current = undefined; }
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [playing, ready, frame, index, summary.frames]);

  const seek = (value: number) => { anchor.current = undefined; setIndex(value); };
  const elapsed = ((frame?.tick ?? summary.firstTick) - summary.firstTick) / 35;
  return <section className="evaluation-replay" aria-label="Recorded selected route">
    <div className="evaluation-screen">{frame ? <img src={`data:image/png;base64,${frame.frame}`} alt={`Recorded ${frame.label}, tick ${frame.tick}`} /> : <span>Loading recording…</span>}</div>
    <div className="evaluation-toolbar">
      <button type="button" onClick={() => {
        anchor.current = undefined;
        if (index >= summary.frames - 1) setIndex(0);
        setPlaying(value => !value);
      }}>{playing ? 'Pause replay' : 'Play replay'}</button>
      <small>{elapsed.toFixed(1)} / {((summary.lastTick - summary.firstTick) / 35).toFixed(1)}s{!ready && !error ? ' · loading' : ''}</small>
    </div>
    <input type="range" min={0} max={summary.frames - 1} value={index} onChange={event => seek(Number(event.target.value))} aria-label="Replay position" />
    {frame && <small>{frame.label} · health {frame.health} · {frame.kills} map kills</small>}
    {summary.incomplete && <p className="evaluation-caption">Partial recording. {summary.error ?? 'Some earlier gameplay is unavailable.'}</p>}
    {error && <p role="alert" className="skill-error">{error}</p>}
  </section>;
}
