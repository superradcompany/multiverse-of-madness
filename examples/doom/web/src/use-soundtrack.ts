import { useEffect, useRef, useState } from 'react';
import type { SessionView, WorldView } from '../../contracts/src/session.ts';
import { Soundtrack, type AudioMix } from './soundtrack.ts';
const savedVolume = () => { const n = Number(localStorage.getItem('mom-audio-volume') ?? '.15'); return Number.isFinite(n) ? Math.max(0, Math.min(.4, n)) : .15; };
export function useSoundtrack(session: SessionView | undefined, replay: { enabled: boolean; playing: boolean; world?: WorldView }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('mom-audio-enabled') === 'true');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [music, setMusic] = useState(localStorage.getItem('mom-music') !== 'false');
  const [effects, setEffects] = useState(localStorage.getItem('mom-effects') !== 'false');
  const [volume, setVolume] = useState(savedVolume);
  const engine = useRef<Soundtrack | null>(null);
  const previous = useRef<{ stage: string; mainId: string } | undefined>(undefined);
  const playing = replay.enabled ? replay.playing : Boolean(session?.running || session?.busy || session?.worlds.some(w => w.controller === 'human' && w.status === 'running'));
  const worlds = replay.enabled ? replay.world ? [replay.world] : [] : session?.worlds.filter(w => w.role !== 'archived') ?? [];
  const intensity = worlds.some(w => w.state.alive && (w.state.health < 35 || w.state.enemies.some(e => e.distance < 320))) ? .85 : !replay.enabled && session?.stage === 'exploring' ? .4 : .18;
  const mix = useRef<AudioMix>({ music, effects, volume, playing, intensity });
  mix.current = { music, effects, volume, playing, intensity };
  const ensureEngine = () => {
    engine.current ??= new Soundtrack(Number(sessionStorage.getItem('mom-score-position') ?? 0));
    engine.current.update(mix.current);
    return engine.current;
  };
  useEffect(() => {
    engine.current?.update(mix.current);
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
    localStorage.setItem('mom-audio-enabled', String(enabled));
    if (!enabled) { setNeedsGesture(false); void engine.current?.setEnabled(false); return; }
    const audio = ensureEngine();
    const state = () => setNeedsGesture(!document.hidden && audio.context.state !== 'running');
    const resume = () => { void audio.setEnabled(!document.hidden).then(state).catch(state); state(); };
    const gesture = (event: Event) => {
      // The explicit sound toggle handles itself; do not turn a resume click into mute.
      const label = event.target instanceof Element ? event.target.closest('button')?.getAttribute('aria-label') : null;
      if (label && ['Resume sounds', 'Enable sounds', 'Mute sounds'].includes(label)) return;
      if (audio.context.state !== 'running') resume();
    };
    audio.context.addEventListener('statechange', state);
    document.addEventListener('visibilitychange', resume);
    document.addEventListener('pointerdown', gesture);
    document.addEventListener('keydown', gesture);
    resume();
    return () => {
      audio.context.removeEventListener('statechange', state);
      document.removeEventListener('visibilitychange', resume);
      document.removeEventListener('pointerdown', gesture);
      document.removeEventListener('keydown', gesture);
    };
  }, [enabled]);
  useEffect(() => {
    const savePosition = () => { if (engine.current) sessionStorage.setItem('mom-score-position', String(engine.current.position)); };
    const timer = setInterval(savePosition, 2000);
    window.addEventListener('pagehide', savePosition);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', savePosition); savePosition(); void engine.current?.dispose(); engine.current = null; };
  }, []);
  const toggle = async () => {
    const next = needsGesture || !enabled;
    const audio = ensureEngine();
    localStorage.setItem('mom-audio-enabled', String(next)); setEnabled(next);
    await audio.setEnabled(next);
    setNeedsGesture(next && audio.context.state !== 'running');
  };
  return { enabled, needsGesture, music, effects, volume, setMusic, setEffects, setVolume, toggle };
}
