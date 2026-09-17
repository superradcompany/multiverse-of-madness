import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorldView } from '../../../packages/contracts/src/session.ts';
import type { ReplayPath } from '../../../packages/contracts/src/replay.ts';

type RecordedWorld = { id: string; label: string; parentId?: string; selected: boolean; frames: number; firstFrame: number; firstTick: number; lastTick: number };
type Recording = { world: WorldView; at: number; frame: string };
const time = (ticks: number) => `${(ticks / 35).toFixed(1)}s`;
export function useReplay() {
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
    setPath(undefined); setRecord(undefined); setPlaying(false); setError(''); setLoading(true);
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
      while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
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
        if (playing && points[index + 1]) void load(points[index + 1]!).catch(() => {});
      }).catch(e => { if (!cancelled) { setError(e.message); setPlaying(false); cache.current.delete(`${point.worldId}:${point.frame}`); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, playing ? 0 : 60);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [enabled, points, index, playing]);
  useEffect(() => {
    if (!enabled || !playing || !record || loading || error) return;
    if (index >= stopAt || !points[index + 1]) { setPlaying(false); return; }
    // Use game time, including the actual tick spacing of older recordings.
    const delay = Math.max(1, points[index + 1]!.tick - points[index]!.tick) * 1000 / 35;
    const timer = setTimeout(() => setIndex(value => value + 1), delay);
    return () => clearTimeout(timer);
  }, [enabled, playing, record, loading, error, index, stopAt, points]);
  const choose = (id: string) => { setPlaying(false); setWorldId(id); setIndex(0); setRecord(undefined); setRevision(v => v + 1); };
  const open = (id: string) => {
    const world = worlds.find(w => w.id === id) ?? worlds.at(-1);
    if (world) { setSingle(false); choose(world.id); setEnabled(true); }
  };
  const panel = enabled && <div className="replay-controls" aria-label="Recorded gameplay">
    <div><strong>{single ? 'world replay' : 'full run replay'}</strong><button disabled={!record || !!error} onClick={() => { if (!playing && index >= stopAt) { setIndex(0); setStopAt(points.length - 1); } setPlaying(!playing); }}>{playing ? 'pause replay' : 'play recording'}</button><button onClick={() => setEnabled(false)}>return to live</button></div>
    <div className="replay-mode"><button aria-pressed={!single} onClick={() => setSingle(false)}>full path</button><button aria-pressed={single} onClick={() => setSingle(true)}>this world only</button><button onClick={() => setRevision(v => v + 1)}>refresh recording</button></div>
    <select aria-label="Replay endpoint world" value={worldId} onChange={e => choose(e.target.value)}>{worlds.map((w, i) => <option key={w.id} value={w.id}>world {i + 1} · {w.label}{w.selected ? ' · retained path' : ''} · tick {w.lastTick}</option>)}</select>
    {path?.missingHistory && <p className="replay-warning">Some earlier footage is unavailable. This replay includes only retained history.</p>}
    <input aria-label="Replay position" type="range" min={0} max={Math.max(0, points.length - 1)} value={index} disabled={!points.length} onChange={e => { setPlaying(false); setIndex(Number(e.target.value)); }} />
    <div className="replay-detail"><span>{error || (loading && !record ? 'loading recording…' : `${time((record?.world.state.tick ?? path?.firstTick ?? 0) - (path?.firstTick ?? 0))} / ${time((path?.lastTick ?? 0) - (path?.firstTick ?? 0))} · tick ${record?.world.state.tick ?? '…'}`)}</span><span>{path?.segments.length ?? 0} worlds stitched</span></div>
    <div className="replay-end"><span>stop at {time((points[stopAt]?.tick ?? 0) - (path?.firstTick ?? 0))}</span><button disabled={index === 0 || !record || !!error} onClick={() => { setStopAt(index); setIndex(0); setPlaying(true); }}>play from start to here</button></div>
  </div>;
  return { enabled, playing, record, open, close: () => setEnabled(false), panel, available: worlds.length > 0, recordingError };
}
