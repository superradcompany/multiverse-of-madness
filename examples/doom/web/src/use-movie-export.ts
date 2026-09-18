import { useEffect, useState } from 'react';
import type { ReplayPath } from '../../contracts/src/replay.ts';

type Movie = { id: string; status: 'encoding' | 'ready' | 'error' | 'cancelled'; progress: number; error?: string };
async function response(response: Response): Promise<Movie> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Movie export failed.');
  return data;
}
export function useMovieExport() {
  const [movie, setMovie] = useState<Movie>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!movie || movie.status !== 'encoding') return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetch(`/api/movie-exports/${movie.id}`, { signal: controller.signal }).then(response).then(setMovie).catch(e => {
        if (!controller.signal.aborted) { setError(e.message); setMovie(undefined); }
      });
    }, 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [movie?.id, movie?.status]);
  const start = async (path: ReplayPath, single: boolean, untilTick = path.lastTick) => {
    setStarting(true); setError(''); setMovie(undefined);
    try {
      setMovie(await response(await fetch('/api/movie-exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: path.endpointId, untilTick, single, allowPartial: path.missingHistory }) })));
    } catch (e) { setError(e instanceof Error ? e.message : 'Movie export failed.'); }
    finally { setStarting(false); }
  };
  const cancel = async () => {
    if (!movie) return;
    try { setMovie(await response(await fetch(`/api/movie-exports/${movie.id}`, { method: 'DELETE' }))); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel export.'); }
  };
  return { movie, start, cancel, busy: starting || movie?.status === 'encoding', error: error || movie?.error };
}
