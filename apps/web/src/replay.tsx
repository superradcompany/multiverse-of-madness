import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Download, RefreshCw, Maximize2, X, Film, ChevronDown, Scissors } from 'lucide-react';
import { useMovieExport } from './use-movie-export.ts';
import { ReplaySidebar, type RecordedWorld } from './replay-sidebar.tsx';
import type { WorldView } from '../../../packages/contracts/src/session.ts';
import type { ReplayPath } from '../../../packages/contracts/src/replay.ts';

type Recording = { world: WorldView; at: number; frame: string };
const time = (ticks: number) => { const seconds = Math.max(0, Math.floor(ticks / 35)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
export function useReplay() {
  const exporter = useMovieExport();
  const [speed, setSpeed] = useState(1);
  const playbackAnchor = useRef<{ at: number; tick: number } | undefined>(undefined);
  const [enabled, setEnabled] = useState(false);
  const [worlds, setWorlds] = useState<RecordedWorld[]>([]);
  const [worldId, setWorldId] = useState('');
  const [single, setSingle] = useState(false);
  const [path, setPath] = useState<ReplayPath>();
  const [revision, setRevision] = useState(0);
  const [index, setIndex] = useState(0);
  const [stopAt, setStopAt] = useState(0);
  const [record, setRecord] = useState<Recording>();
  const [error, setError] = useState('');
  const [recordingError, setRecordingError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, Promise<Recording>>());
  const requests = useRef(new AbortController());
  const points = useMemo(() => path?.segments.flatMap(segment => segment.ticks.map((tick, offset) => ({ worldId: segment.worldId, frame: segment.firstFrame + offset, tick }))) ?? [], [path]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/recordings');
        if (!response.ok) throw new Error('Could not load recordings');
        const data = await response.json();
        if (!stopped) { setWorlds(data.worlds); setRecordingError(data.error ?? ''); }
      } catch (e) { if (!stopped) setRecordingError(e instanceof Error ? e.message : 'Recording unavailable'); }
    };
    void refresh(); const timer = setInterval(refresh, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!enabled || !worldId) return;
    const controller = new AbortController(); requests.current = controller; cache.current.clear();
    playbackAnchor.current = undefined; setPath(undefined); setRecord(undefined); setPlaying(false); setError(''); setLoading(true);
    void fetch(`/api/replay-path?worldId=${encodeURIComponent(worldId)}&single=${single}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Recording unavailable. It may have been cleared or expired.'); return response.json() as Promise<ReplayPath>; })
      .then(value => { if (!controller.signal.aborted) { setPath(value); setIndex(0); setStopAt(Math.max(0, value.frames - 1)); if (!value.frames) setError('No retained frames at this point.'); } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, worldId, single, revision]);
  const load = (point: typeof points[number]) => {
    const key = `${point.worldId}:${point.frame}`;
    let pending = cache.current.get(key);
    if (!pending) {
      pending = fetch(`/api/recordings/${encodeURIComponent(point.worldId)}/${point.frame}`, { signal: requests.current.signal })
        .then(async response => { if (!response.ok) throw new Error('Frame unavailable. Refresh the recording to check retained history.'); return response.json() as Promise<Recording>; })
        .then(async data => { const image = new Image(); image.src = `data:image/png;base64,${data.frame}`; await image.decode(); return data; });
      cache.current.set(key, pending);
      while (cache.current.size > 64) cache.current.delete(cache.current.keys().next().value!);
    }
    return pending;
  };
  useEffect(() => {
    const point = points[index];
    if (!enabled || !point) return;
    let cancelled = false;
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      void load(point).then(data => {
        if (cancelled) return;
        setRecord(data);
        if (playing) for (const next of points.slice(index + 1, index + 5)) void load(next).catch(() => {});
      }).catch(e => { if (!cancelled) { setError(e.message); setPlaying(false); cache.current.delete(`${point.worldId}:${point.frame}`); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, playing ? 0 : 60);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [enabled, points, index, playing]);
  useEffect(() => {
    if (!enabled || !playing || !record || loading || error) return;
    if (index >= stopAt || !points[index + 1]) { setPlaying(false); return; }
    // Use game time, including the actual tick spacing of older recordings.
    playbackAnchor.current ??= { at: performance.now(), tick: points[index]!.tick };
    const anchor = playbackAnchor.current;
    const delay = Math.max(1, anchor.at + (points[index + 1]!.tick - anchor.tick) * 1000 / (35 * speed) - performance.now());
    const timer = setTimeout(() => {
      const target = anchor.tick + (performance.now() - anchor.at) * 35 * speed / 1000;
      let next = index + 1;
      while (next < stopAt && points[next + 1] && points[next + 1]!.tick <= target) next++;
      setIndex(next);
    }, delay);
    return () => clearTimeout(timer);
  }, [enabled, playing, record, loading, error, index, stopAt, points, speed]);
  const choose = (id: string) => { setPlaying(false); setWorldId(id); setIndex(0); setRecord(undefined); setRevision(v => v + 1); };
  const open = (id: string) => {
    const world = worlds.find(w => w.id === id) ?? worlds.at(-1);
    if (world) { setSingle(false); choose(world.id); setEnabled(true); }
  };
  const seek = (tick: number) => {
    let low = 0, high = Math.max(0, points.length - 1);
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (points[mid]!.tick <= tick) low = mid; else high = mid - 1; }
    playbackAnchor.current = undefined; setIndex(low);
  };
  const toggle = () => {
    playbackAnchor.current = undefined;
    if (!playing && index >= stopAt) { setIndex(0); setStopAt(points.length - 1); }
    setPlaying(!playing);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || (event.target as HTMLElement).closest('button, input, select, textarea, summary, a')) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); if (record && !error) toggle(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek((points[index]?.tick ?? 0) + (event.key === 'ArrowLeft' ? -175 : 175)); }
  };
  const currentTick = points[index]?.tick ?? path?.firstTick ?? 0;
  const duration = (path?.lastTick ?? 0) - (path?.firstTick ?? 0);
  const limited = stopAt < points.length - 1;
  const panel = enabled && <>
    <div className="replay-top"><span><Film size={15} /> {single ? 'World replay' : 'Full run replay'}</span><button onClick={() => setEnabled(false)}>Back to live <X size={15} /></button></div>
    <div className="replay-controls" aria-label="Recorded gameplay controls">
      <div className="replay-heading"><div><strong>{record?.world.plan?.label ?? record?.world.label ?? 'Loading recording…'}</strong><span>{record ? `${record.world.state.health} health · ${record.world.state.kills} map kills` : ''}</span></div><span className="replay-chapters">{path?.segments.length ?? 0} worlds stitched</span></div>
      {path?.missingHistory && <p className="replay-warning">Earlier footage is missing. Playback and export include the available footage.</p>}
      {error && <p className="replay-warning" role="alert">{error}</p>}
      {(exporter.busy || exporter.movie?.status === 'ready' || exporter.error) && <div className="movie-status" role="status">
        <span>{exporter.error || (exporter.movie?.status === 'ready' ? 'Your MP4 is ready' : `Exporting movie… ${exporter.movie?.progress ?? 0}%`)}</span>
        {exporter.busy && <><progress max="100" value={exporter.movie?.progress ?? 0} /><button className="replay-icon" aria-label="Cancel export" disabled={!exporter.movie} onClick={() => void exporter.cancel()}><X size={16} /></button></>}
        {exporter.movie?.status === 'ready' && <a href={`/api/movie-exports/${exporter.movie.id}/file`} download><Download size={14} /> Save MP4</a>}
      </div>}
      <input className="replay-scrubber" aria-label="Replay position" aria-valuetext={`${time(currentTick - (path?.firstTick ?? 0))} of ${time(duration)}`} type="range" min={path?.firstTick ?? 0} max={path?.lastTick ?? 0} value={currentTick} disabled={!points.length} style={{ '--progress': `${duration ? (currentTick - path!.firstTick) / duration * 100 : 0}%` } as React.CSSProperties} onChange={e => seek(Number(e.target.value))} />
      <div className="replay-toolbar">
        <button className="replay-icon replay-play" aria-label={playing ? 'Pause replay' : 'Play replay'} title="Play / pause · Space" disabled={!record || !!error} onClick={toggle}>{playing ? <Pause /> : <Play />}</button>
        <button className="replay-icon replay-skip" aria-label="Back 5 seconds" title="Back 5 seconds · ←" disabled={!points.length} onClick={() => seek(currentTick - 175)}><RotateCcw size={19} /><small>5</small></button>
        <button className="replay-icon replay-skip" aria-label="Forward 5 seconds" title="Forward 5 seconds · →" disabled={!points.length} onClick={() => seek(currentTick + 175)}><RotateCw size={19} /><small>5</small></button>
        <span className="replay-time">{time(currentTick - (path?.firstTick ?? 0))}<span> / {time(duration)}</span></span>
        <div className="replay-tools">
          <select className="replay-speed" aria-label="Playback speed" title="Playback speed" value={speed} onChange={e => { playbackAnchor.current = undefined; setSpeed(Number(e.target.value)); }}>{[.5, 1, 1.5, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select>
          <details className="replay-library"><summary title="Recording and clip options"><Film size={17} /><ChevronDown size={12} /><span className="sr-only">Recording and clip options</span></summary><div>
            <label htmlFor="replay-world">Recording endpoint</label>
            <select id="replay-world" value={worldId} onChange={e => choose(e.target.value)}>{worlds.map((w, i) => <option key={w.id} value={w.id}>World {i + 1} · {w.label}{w.selected ? ' · selected path' : ''}</option>)}</select>
            <div className="replay-mode"><button aria-pressed={!single} onClick={() => setSingle(false)}>Full run</button><button aria-pressed={single} onClick={() => setSingle(true)}>This world</button></div>
            <button className="replay-menu-action" onClick={() => setRevision(v => v + 1)}><RefreshCw size={15} /> Refresh recording</button>
            <button className="replay-menu-action" disabled={index === 0 || !record || !!error} onClick={() => { playbackAnchor.current = undefined; setStopAt(index); setIndex(0); setPlaying(true); }}><Scissors size={15} /> Play from start to here</button>
            {limited && <button className="replay-menu-action" onClick={() => setStopAt(points.length - 1)}>Clear playback endpoint ({time((points[stopAt]?.tick ?? 0) - (path?.firstTick ?? 0))})</button>}
            <button className="replay-menu-action" disabled={index === 0 || !path || exporter.busy} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); if (path) void exporter.start(path, single, currentTick); }}><Download size={15} /> Export through this point</button>
            <p>MP4 exports use original game speed. Audio was not recorded.</p>
          </div></details>
          <button className="replay-icon replay-export-shortcut" aria-label="Export full recording as MP4" title={path?.missingHistory ? 'Export available footage as MP4' : 'Export full recording as MP4'} disabled={!path?.frames || exporter.busy} onClick={() => path && void exporter.start(path, single)}><Download size={19} /></button>
          <button className="replay-icon" aria-label="Fullscreen replay" title="Fullscreen" onClick={e => { const player = e.currentTarget.closest('.player'); if (document.fullscreenElement) void document.exitFullscreen(); else void player?.requestFullscreen(); }}><Maximize2 size={18} /></button>
        </div>
      </div>
    </div>
  </>;
  const sidebar = enabled && <ReplaySidebar worlds={worlds} worldId={worldId} single={single} path={path} currentTick={currentTick} choose={choose} setSingle={setSingle} refresh={() => setRevision(v => v + 1)} exporter={exporter} limited={limited} clearEndpoint={() => setStopAt(points.length - 1)} playToHere={() => { playbackAnchor.current = undefined; setStopAt(index); setIndex(0); setPlaying(true); }} />;
  return { enabled, playing, record, open, keyDown, sidebar, close: () => setEnabled(false), panel, available: worlds.length > 0, recordingError };
}
