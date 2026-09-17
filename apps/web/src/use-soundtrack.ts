import { useEffect, useRef, useState } from 'react';
import type { SessionView, WorldView } from '../../../packages/contracts/src/session.ts';
import { Soundtrack } from './soundtrack.ts';
const savedVolume = () => { const n = Number(localStorage.getItem('mom-audio-volume') ?? '.15'); return Number.isFinite(n) ? Math.max(0, Math.min(.4, n)) : .15; };
export function useSoundtrack(session: SessionView | undefined, replay: { enabled: boolean; playing: boolean; world?: WorldView }) {
  const [enabled, setEnabled] = useState(false);
  const [music, setMusic] = useState(localStorage.getItem('mom-music') !== 'false');
  const [effects, setEffects] = useState(localStorage.getItem('mom-effects') !== 'false');
  const [volume, setVolume] = useState(savedVolume);
  const engine = useRef<Soundtrack | null>(null);
  const previous = useRef<{ stage: string; mainId: string } | undefined>(undefined);
  const playing = replay.enabled ? replay.playing : Boolean(session?.running || session?.busy || session?.worlds.some(w => w.controller === 'human' && w.status === 'running'));
  const worlds = replay.enabled ? replay.world ? [replay.world] : [] : session?.worlds.filter(w => w.role !== 'archived') ?? [];
  const intensity = worlds.some(w => w.state.alive && (w.state.health < 35 || w.state.enemies.some(e => e.distance < 320))) ? .85 : !replay.enabled && session?.stage === 'exploring' ? .4 : .18;
  useEffect(() => {
    engine.current?.update({ music, effects, volume, playing, intensity });
    localStorage.setItem('mom-music', String(music)); localStorage.setItem('mom-effects', String(effects)); localStorage.setItem('mom-audio-volume', String(volume));
  }, [music, effects, volume, playing, intensity]);
  useEffect(() => {
    if (!session) return;
    const old = previous.current;
    if (old && !replay.enabled) {
      if (old.stage !== 'forking' && session.stage === 'forking') engine.current?.cue('fork');
      else if (old.mainId !== session.mainId) engine.current?.cue('winner');
    }
    previous.current = { stage: session.stage, mainId: session.mainId };
  }, [session?.stage, session?.mainId, replay.enabled]);
  useEffect(() => {
    const visibility = () => { void engine.current?.setEnabled(enabled && !document.hidden).catch(() => setEnabled(false)); };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [enabled]);
  useEffect(() => () => { void engine.current?.dispose(); engine.current = null; }, []);
  const toggle = async () => {
    const next = !enabled;
    engine.current ??= new Soundtrack();
    engine.current.update({ music, effects, volume, playing, intensity });
    await engine.current.setEnabled(next); setEnabled(next);
  };
  return { enabled, music, effects, volume, setMusic, setEffects, setVolume, toggle };
}
