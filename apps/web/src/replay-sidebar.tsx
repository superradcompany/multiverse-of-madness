import { useState } from 'react';
import { Check, Download, Film, RefreshCw, Search, Scissors, X } from 'lucide-react';
import type { ReplayPath } from '../../../packages/contracts/src/replay.ts';
import type { useMovieExport } from './use-movie-export.ts';
export type RecordedWorld = { id: string; label: string; parentId?: string; selected: boolean; frames: number; firstFrame: number; firstTick: number; lastTick: number };

export function ReplaySidebar({ worlds, worldId, single, path, currentTick, choose, setSingle, refresh, exporter, playToHere, clearEndpoint, limited }: {
  worlds: RecordedWorld[]; worldId: string; single: boolean; path?: ReplayPath; currentTick: number;
  playToHere: () => void; clearEndpoint: () => void; limited: boolean;
  choose: (id: string) => void; setSingle: (value: boolean) => void; refresh: () => void; exporter: ReturnType<typeof useMovieExport>;
}) {
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(true);
  const [limit, setLimit] = useState(12);
  const choices = worlds.map((world, index) => ({ ...world, number: index + 1 })).reverse()
    .filter(w => (!selectedOnly || w.selected || w.id === worldId) && `${w.label} ${w.number}`.toLowerCase().includes(query.toLowerCase()));
  const selected = worlds.find(w => w.id === worldId);
  const movie = exporter.movie;
  return <>
    <div className="sidebar-head replay-sidebar-heading"><span><Film size={16} /> Recording history</span><button className="icon" aria-label="Refresh recording" title="Include newly recorded gameplay" onClick={refresh}><RefreshCw size={16} /></button></div>
    <div className="worlds replay-history">
      <div className="replay-scope"><button aria-pressed={!single} onClick={() => setSingle(false)}>Full run</button><button aria-pressed={single} onClick={() => setSingle(true)}>This world</button></div>
      <p className="recording-context">{single ? 'Footage from this world only.' : 'Selected ancestry up to this world.'}</p>
      <details className="recording-range"><summary>Playback range{limited ? ' · endpoint set' : ''}</summary><button disabled={!path?.frames || currentTick <= path.firstTick} onClick={playToHere}><Scissors size={14} /> Play from start to playhead</button>{limited && <button onClick={clearEndpoint}>Clear playback endpoint</button>}</details>
      <label className="recording-search"><Search size={14} /><input type="search" aria-label="Search recordings" placeholder="Find a recording…" value={query} onChange={e => { setQuery(e.target.value); setLimit(12); }} /></label>
      <label className="recording-filter"><input type="checkbox" checked={selectedOnly} onChange={e => { setSelectedOnly(e.target.checked); setLimit(12); }} /> Selected path only <span>{choices.length}</span></label>
      <div className="recording-list">{choices.slice(0, limit).map(world => <button key={world.id} className={`recording-entry ${world.id === worldId ? 'selected' : ''}`} aria-pressed={world.id === worldId} onClick={() => choose(world.id)}><div><strong>{world.label}</strong><span>World {world.number} · {(world.lastTick / 35).toFixed(1)}s{world.selected ? ' · selected' : ''}</span></div>{world.id === worldId && <Check size={16} />}</button>)}</div>
      {!choices.length && <p className="recording-context">No recordings match.</p>}
      {choices.length > limit && <button className="recording-more" onClick={() => setLimit(limit + 12)}>Show more recordings</button>}
    </div>
    <section className="replay-export" aria-label="Movie export">
      <div className="export-heading"><h3>Export movie</h3><span>MP4</span></div>
      <p className="export-source" title={selected?.label}>{selected?.label ?? 'Choose a recording'}</p>
      <button className="primary export-full" disabled={!path?.frames || exporter.busy} onClick={() => path && void exporter.start(path, single)}><Download size={16} />{path?.missingHistory ? 'Export available footage' : single ? 'Export this world' : 'Export full run'}</button>
      <button className="export-point" disabled={!path?.frames || currentTick <= path.firstTick || exporter.busy} onClick={() => path && void exporter.start(path, single, currentTick)}><Scissors size={14} /> Export to playhead</button>
      <p className="export-note">Original speed · no recorded audio{path?.missingHistory ? ' · earlier footage missing' : ''}</p>
      {(exporter.busy || movie?.status === 'ready' || exporter.error) && <div className="sidebar-export-status" role="status"><span>{exporter.error || (movie?.status === 'ready' ? 'Movie ready' : `Exporting… ${movie?.progress ?? 0}%`)}</span>{exporter.busy && <><progress max="100" value={movie?.progress ?? 0} /><button className="icon" aria-label="Cancel movie export" disabled={!movie} onClick={() => void exporter.cancel()}><X size={14} /></button></>}{movie?.status === 'ready' && <a href={`/api/movie-exports/${movie.id}/file`} download>Save MP4 <Download size={14} /></a>}</div>}
    </section>
  </>;
}
