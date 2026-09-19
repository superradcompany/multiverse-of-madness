import { GameSessionMenu } from '../../../shared/web/src/game-session-menu.tsx';
import { SupervisorGuidance } from './supervisor-guidance.tsx';
import { VmSettingsPanel } from './vm-settings.tsx';
import { applySessionUpdate, type SessionPatch, type SessionUpdate } from '../../contracts/src/session-stream.ts';
import { LearningSettings, LearningStatus, useBackgroundLearning } from './background-learning.tsx';
import { useSoundtrack } from './use-soundtrack.ts';
import { SkillsPanel } from './skills-panel.tsx';
import { DecisionSettings } from './decision-settings.tsx';
import { PlanProgress } from './plan-progress.tsx';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GitFork, Pause, Play, Volume2, VolumeX, ArrowUp, Gamepad2, Bot, ChevronDown, ChevronUp, History, GripHorizontal, Crosshair, Maximize2, SlidersHorizontal } from 'lucide-react';
import { defaultStallForkSeconds, type SessionView } from '../../contracts/src/session.ts';
import type { Input } from '../../contracts/src/game.ts';
import './style.css';
import { RunPerformance } from './run-performance.tsx';
import { LiveSidebar } from './live-sidebar.tsx';
import { RestartGame } from './restart.tsx';
import { useReplay } from './replay.tsx';
import { Director, directorWorlds, frameUrl } from './director.tsx';

function App() {
  const replay = useReplay();
  const learning = useBackgroundLearning();
  const [session, setSession] = useState<SessionView>();
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(localStorage.getItem('mom-selected') ?? '');
  const [follow, setFollow] = useState(localStorage.getItem('mom-follow') !== 'false');
  const [direction, setDirection] = useState('');
  const [guideExpanded, setGuideExpanded] = useState(() => localStorage.getItem('mom-guide-expanded') === 'true');
  useEffect(() => { localStorage.setItem('mom-guide-expanded', String(guideExpanded)); }, [guideExpanded]);
  const soundtrack = useSoundtrack(session, { enabled: replay.enabled, playing: replay.playing, world: replay.record?.world });
  const { enabled: sound, volume, setVolume } = soundtrack;
  const [history, setHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(localStorage.getItem('mom-commentary-collapsed') === 'true');
  const [position, setPosition] = useState(() => { try { return JSON.parse(localStorage.getItem('mom-commentary-position') ?? '{"x":20,"y":60}'); } catch { return { x: 20, y: 60 }; } });
  const overlay = useRef<HTMLDivElement>(null), player = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<Input>());
  const sending = useRef(false);
  const command = async (data: object, onError?: (message: string) => void) => {
    try {
      const response = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSession(result); setError(''); return true;
    } catch (e) { const message = e instanceof Error ? e.message : 'Connection failed'; setError(message); onError?.(message); return false; }
  };
  useEffect(() => {
    let socket: WebSocket, retry: ReturnType<typeof setTimeout>, stopped = false;
    const connect = () => {
      let streamView: SessionView | undefined;
      socket = new WebSocket(`ws://${location.host}/api/events`, 'mom-session-patches');
      socket.onopen = () => setConnected(true);
      socket.onmessage = event => {
        const message: SessionView | SessionUpdate | SessionPatch = JSON.parse(event.data);
        if ('type' in message) {
          if (!streamView) { socket.close(); return; }
          streamView = applySessionUpdate(streamView, message);
        } else streamView = message;
        // HTTP command replies may update the UI too; the delta cursor belongs only to this socket.
        setSession(streamView);
      };
      socket.onclose = () => { setConnected(false); if (!stopped) retry = setTimeout(connect, 1000); };
    };
    connect(); return () => { stopped = true; clearTimeout(retry); socket.close(); };
  }, []);
  const focused = session?.worlds.find(w => w.id === (follow ? session.mainId : selected)) ?? session?.worlds.find(w => w.id === session.mainId);
  useEffect(() => { localStorage.setItem('mom-selected', selected); localStorage.setItem('mom-follow', String(follow)); }, [selected, follow]);
  useEffect(() => { localStorage.setItem('mom-commentary-collapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => {
    if (!overlay.current || collapsed) return;
    const saved = localStorage.getItem('mom-commentary-size');
    if (saved) { const size = JSON.parse(saved); overlay.current.style.width = `${size.width}px`; overlay.current.style.height = `${size.height}px`; }
    const resize = new ResizeObserver(() => {
      const element = overlay.current;
      if (!element || element.classList.contains('collapsed')) return;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return; // Director view temporarily hides this overlay.
      localStorage.setItem('mom-commentary-size', JSON.stringify({ width: box.width, height: box.height }));
      const container = player.current;
      if (container) setPosition((old: { x: number; y: number }) => {
        const next = { x: Math.max(0, Math.min(old.x, container.clientWidth - box.width)), y: Math.max(0, Math.min(old.y, container.clientHeight - box.height)) };
        return next.x === old.x && next.y === old.y ? old : next;
      });
    });
    resize.observe(overlay.current); return () => resize.disconnect();
  }, [collapsed, Boolean(session)]);
  useEffect(() => {
    if (replay.enabled || focused?.controller !== 'human' || focused.status !== 'running') return;
    const mapping: Record<string, Input> = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'backward', ArrowDown: 'backward', ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'strafeLeft', KeyD: 'strafeRight', Space: 'fire', KeyE: 'use' };
    const down = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) { keys.current.clear(); return; }
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      const key = mapping[event.code]; if (key) { event.preventDefault(); keys.current.add(key); }
    };
    const up = (event: KeyboardEvent) => { const key = mapping[event.code]; if (key) keys.current.delete(key); };
    const clear = () => keys.current.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    const timer = setInterval(() => {
      if (sending.current || document.hidden) return;
      sending.current = true;
      void command({ type: 'input', worldId: focused.id, inputs: [...keys.current] }).finally(() => { sending.current = false; });
    }, 1000 / 35);
    return () => { clearInterval(timer); clear(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); };
  }, [focused?.id, focused?.controller, focused?.status, replay.enabled]);
  const drag = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const origin = { x: event.clientX, y: event.clientY, ...position };
    const startX = event.clientX, startY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget;
    const move = (e: PointerEvent) => {
      const bounds = player.current!.getBoundingClientRect(), box = overlay.current!.getBoundingClientRect();
      const next = { x: Math.max(0, Math.min(bounds.width - box.width, origin.x + e.clientX - startX)), y: Math.max(0, Math.min(bounds.height - box.height, origin.y + e.clientY - startY)) };
      setPosition(next); localStorage.setItem('mom-commentary-position', JSON.stringify(next));
    };
    const stop = () => { target.removeEventListener('pointermove', move as EventListener); target.removeEventListener('pointerup', stop); };
    target.addEventListener('pointermove', move as EventListener); target.addEventListener('pointerup', stop, { once: true });
  };
  const icon = (label: string, content: React.ReactNode, onClick: () => void, active = false, disabled = false) => <button className={`icon ${active ? 'active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{content}</button>;
  if (!session || !focused) return <div className="loading"><GitFork /><h1>multiverse of madness</h1><p>Connecting to your session…</p></div>;
  const directing = follow && !replay.enabled && (session.stage === 'forking' || directorWorlds(session).length > 0);
  const inspect = (id: string) => { setSelected(id); setFollow(false); };
  const displayed = replay.enabled ? replay.record?.world : focused;
  const humanPlaying = session.worlds.some(w => w.controller === 'human' && w.status === 'running');
  const comments = session.commentary.filter(c => c.worldId === focused.id);
  const experiments = session.worlds.filter(w => w.role === 'experiment');
  const comparing = session.stage === 'choosing';
  const countdown = session.reviewEndsAt ? Math.max(0, Math.ceil((session.reviewEndsAt - now) / 1000)) : undefined;
  const phaseTitle = session.stage === 'acting' ? `${session.decision?.kind === 'plan' ? 'Following a plan' : 'Taking one action'}: ${session.decision?.action ?? 'playing'}` : session.stage === 'deciding' ? 'Jev is reading the game state' : session.stage === 'forking' ? session.decision?.mode === 'manual' ? 'You requested a comparison' : session.decision?.mode === 'stalled' ? 'Progress stalled. Testing alternatives.' : 'Jev is uncertain. Testing alternatives.' : session.stage === 'exploring' ? `Testing ${experiments.length} futures side by side` : comparing ? 'Which future worked best?' : session.stage === 'continuing' ? 'The winner becomes the main session' : session.running ? 'Jev is choosing the next approach' : 'Ready when you are';
  const phaseDetail = session.stage === 'acting' ? `${Math.round((session.confidence ?? 0) * 100)}% confidence. Continuing directly without a fork.` : session.stage === 'deciding' ? session.planningMode === 'plans' ? 'Ranking short plans from current game observations.' : 'Ranking actions from player, enemy, and projectile telemetry.' : session.stage === 'forking' ? session.decision?.mode === 'stalled' ? `No useful progress for ${session.decision?.stallForkSeconds ?? defaultStallForkSeconds} game seconds. Comparing alternatives despite model confidence.` : `${Math.round((session.confidence ?? 0) * 100)}% confidence${session.decision?.mode === 'uncertain' ? `, below the ${Math.round((session.decision?.threshold ?? .75) * 100)}% threshold` : ''}. The main session waits here.` : session.stage === 'exploring' ? session.planningMode === 'plans' ? 'Same starting state. Different plans, with progress checked every tick.' : 'Same starting state. Different opening moves, then Jev steers each future.' : comparing ? session.comparison?.reason ?? 'Comparing the observed outcomes.' : session.stage === 'continuing' ? 'Only the chosen future continues. Other futures remain available in the comparison.' : session.manualChoiceRequired ? 'Manual play changed the comparison. Choose a world to continue.' : 'Resume to watch the loop, or explore one decision at a time.';
  return <div className="app">
    <header><div className="brand"><img src="/microsandbox-mark.svg" alt="" aria-hidden="true" /><span>microsandbox</span></div><div className="title"><div className="title-heading"><h1>multiverse of madness</h1><GameSessionMenu game="doom" label="Doom" /></div><span>microsandbox × Jev <i className={connected ? 'online' : ''} /> {connected ? 'connected' : 'reconnecting'}</span></div><div className="controls"><label className="follow"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> auto director</label><div className="header-actions" role="group" aria-label="Session controls"><details className="play-settings"><summary className="icon" aria-label="Playback settings" title="Playback settings"><SlidersHorizontal /></summary><div className="play-settings-panel"><section className="settings-section settings-services"><div className="audio-settings"><strong>soundtrack</strong><label><input type="checkbox" checked={soundtrack.music} onChange={e => soundtrack.setMusic(e.target.checked)} /> adaptive music</label><label><input type="checkbox" checked={soundtrack.effects} onChange={e => soundtrack.setEffects(e.target.checked)} /> event sounds</label><label className="settings-volume">volume<input aria-label="Sound volume" type="range" min="0" max="0.4" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} /></label><p>Parallel Afterglow · original electronic score. Sound preferences are remembered.</p></div><LearningSettings learning={learning} /></section><section className="settings-section"><h3>Exploration & memory</h3><DecisionSettings session={session} command={command} /></section><section className="settings-section"><h3>Decision timing</h3><label htmlFor="winner-delay">continue with winner after</label><select id="winner-delay" aria-label="Winner review delay" value={session.winnerDelaySeconds ?? 0} onChange={e => void command({ type: 'winner-delay', seconds: Number(e.target.value) })}>{[0, 1, 2, 3, 5, 10, 15, 30, 60].map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? 'immediately' : `${seconds} seconds`}</option>)}</select><p>Zero skips the review pause. You can still inspect outcomes in replay.</p><label htmlFor="planning-mode">decision style</label><select id="planning-mode" value={session.planningMode ?? 'plans'} onChange={e => void command({ type: 'planning-mode', mode: e.target.value })}><option value="plans">short conditional plans</option><option value="actions">single actions</option></select><label htmlFor="decision-interval">ask Jev again after</label><select id="decision-interval" aria-label="Jev decision interval" value={(session.decisionIntervalMode ?? (session.planningMode === 'actions' ? 'fixed' : 'trial')) === 'trial' ? 'trial' : session.decisionIntervalTicks ?? 35} onChange={e => void command(e.target.value === 'trial' ? { type: 'decision-interval-mode', mode: 'trial' } : { type: 'decision-interval', ticks: Number(e.target.value) })}><option value="trial">match “compare futures after” ({(session.trialDurationTicks ?? 210) / 35}s)</option>{[...new Set([7, 14, 35, 70, 105, 175, 210, 350, 420, 525, 1050, 2100, session.decisionIntervalTicks ?? 35])].sort((a, b) => a - b).map(ticks => <option key={ticks} value={ticks}>{ticks / 35} game seconds</option>)}</select><p>Works with both decision styles. Plans can reassess sooner on completion, danger or failure. Changes apply to the next decision; matching follows each batch’s comparison duration.</p><label htmlFor="trial-duration">compare futures after</label><select id="trial-duration" aria-label="Trial gameplay duration" value={session.trialDurationTicks ?? 210} onChange={e => void command({ type: 'trial-duration', ticks: Number(e.target.value) })}>{[1, 2, 3, 6, 10, 12, 15, 30, 60].map(seconds => <option key={seconds} value={seconds * 35}>{seconds} game {seconds === 1 ? 'second' : 'seconds'}</option>)}</select><p>Applies to the next batch. Current futures keep their original trial length.</p></section></div></details><VmSettingsPanel session={session} focusedId={focused?.id} /><SkillsPanel session={session} command={command} /><LearningStatus learning={learning} session={session} />{icon('Replay full session', <History />, () => replay.open(session.mainId), replay.enabled, !replay.available)}<RestartGame restart={async () => { const ok = await command({ type: 'restart', confirm: true }); if (ok) { replay.close(); setFollow(true); setSelected(''); } return ok; }} />{icon(session.running || session.busy || humanPlaying ? 'Pause session' : 'Resume AI play', session.running || session.busy || humanPlaying ? <Pause /> : <Play />, () => void command({ type: session.running || session.busy || humanPlaying ? 'pause' : 'resume' }), true)}{icon(soundtrack.needsGesture ? 'Resume sounds' : sound ? 'Mute sounds' : 'Enable sounds', sound ? <Volume2 /> : <VolumeX />, () => { void soundtrack.toggle().catch(e => setError(e instanceof Error ? e.message : 'Audio unavailable')); })}</div></div></header>
    {replay.recordingError && <div className="error" role="status">{replay.recordingError}</div>}
    {(error || session.error) && <div className="error" role="alert">{error || session.error}<button onClick={() => setError('')}>×</button></div>}
    <RunPerformance session={session} />
    <main><section className="focus"><div className={`player ${directing ? 'directing' : ''} ${replay.enabled ? 'replaying' : ''}`} onKeyDown={replay.keyDown} ref={player} tabIndex={0} aria-label="Focused game screen">{directing && <Director phaseTitle={phaseTitle} phaseDetail={phaseDetail} session={session} onFocus={inspect} now={now} />}<div className="single-view" hidden={directing}><img className="game-frame" src={replay.enabled ? replay.record ? `data:image/png;base64,${replay.record.frame}` : undefined : frameUrl(focused)} alt={replay.enabled ? "Recorded game state" : "Live game state"} style={{ visibility: replay.enabled && !replay.record ? "hidden" : "visible" }} /><div className="player-top"><span><i className={focused.status === 'running' ? 'online' : ''} /> {replay.enabled ? 'recorded world · read only' : focused.role === 'main' ? experiments.length ? 'main session · waiting for futures' : 'main session' : focused.label}</span><span>{replay.enabled ? 'replay' : focused.thinking ? 'choosing next approach…' : `${focused.status} · ${focused.controller === 'human' ? 'you' : 'AI'}`}</span></div>{!follow && !replay.enabled && <button className="resume-director" onClick={() => setFollow(true)}>resume auto director</button>}
      {!replay.enabled && <div ref={overlay} className={`commentary ${collapsed ? 'collapsed' : ''}`} style={{ left: `min(${position.x}px, calc(100% - 280px))`, top: `min(${position.y}px, calc(100% - 100px))` }}><div className="commentary-head" onPointerDown={drag}><GripHorizontal size={16} /><span>session commentary</span>{icon('Commentary history', <History size={15} />, () => setHistory(!history), history)}{icon(collapsed ? 'Expand commentary' : 'Collapse commentary', collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />, () => setCollapsed(!collapsed))}</div>{!collapsed && <div className="commentary-body">{(history ? comments.slice(-10) : comments.slice(-1)).map(c => <p key={c.id}>{c.text}</p>)}{!comments.length && <p>Watching this world. Waiting for its next event.</p>}</div>}</div>}
      {replay.panel}<div className="player-bottom"><div><h2>{displayed?.plan?.label ?? displayed?.currentAction ?? displayed?.label ?? "loading recording…"}</h2><PlanProgress plan={displayed?.plan} judging={!replay.enabled && session.stage === 'choosing' && focused.role === 'experiment'} /><span>health {displayed?.state.health ?? "…"} · ammo {displayed?.state.ammo[0] ?? "…"} · {displayed?.state.kills ?? "…"} map kills · tick {displayed?.state.tick ?? "…"}</span></div><div className="world-controls">{!replay.enabled && focused.role !== 'archived' && focused.state.alive && <button className="secondary" onClick={() => void command({ type: focused.controller === 'human' ? 'release' : 'takeover', worldId: focused.id })}>{focused.controller === 'human' ? <Bot size={18} /> : <Gamepad2 size={18} />}{focused.controller === 'human' ? 'return to AI' : 'take control'}</button>}{!replay.enabled && (focused.role === 'experiment' || session.manualChoiceRequired && focused.role === 'main') && focused.state.alive && <button className="primary" disabled={session.busy} onClick={() => void command({ type: 'promote', worldId: focused.id })}>continue from here</button>}{icon(replay.enabled ? 'Return to live' : 'Replay recorded worlds', <History size={18} />, () => replay.enabled ? replay.close() : replay.open(focused.id), replay.enabled, !replay.available)}{icon('Fullscreen player', <Maximize2 size={18} />, () => void player.current?.requestFullscreen())}</div></div>
      {!replay.enabled && focused.controller === 'human' && <div className="key-help">WASD move · ← → turn · space fire · E use</div>}
    </div></div></section><aside>{replay.enabled ? replay.sidebar : <><LiveSidebar session={session} focused={focused} directing={directing} phaseTitle={phaseTitle} phaseDetail={phaseDetail} countdown={countdown} inspect={inspect} command={command} restored={() => { replay.close(); setFollow(true); setSelected(''); }} /><form className={`composer ${guideExpanded ? '' : 'composer-collapsed'}`} onSubmit={e => { e.preventDefault(); if (direction.trim()) { void command({ type: 'direction', text: direction }); setDirection(''); } }}>
      <button type="button" className="guide-toggle" aria-expanded={guideExpanded} aria-controls="guide-fields" onClick={() => setGuideExpanded(!guideExpanded)}><span><Bot size={17} /> guide the AI</span><span>{session.pendingObjective ? <small>queued</small> : direction.trim() ? <small>draft</small> : null}{guideExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</span></button>
      {!guideExpanded && <p className="guide-preview" title={session.pendingObjective ?? session.objective}>{session.pendingObjective ? 'Next: ' : ''}{session.pendingObjective ?? session.objective}</p>}
      <div id="guide-fields" className="guide-fields" hidden={!guideExpanded}>
      <div className="goal-context"><span className="goal-label"><Crosshair size={13} />{session.pendingObjective ? 'Your next goal' : 'Your goal'}</span><p>{session.pendingObjective ?? session.objective}</p></div>
      <div className="input-wrap">
        <textarea aria-label="Direction for AI" placeholder="What should it try next?" value={direction} onChange={e => setDirection(e.target.value)} maxLength={1000} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <div className="prompt-footer"><span title="Applies to all worlds at the next decision">Applies next decision</span><button className="send primary" aria-label="Send direction" title="Send direction · Enter" disabled={!direction.trim()}><ArrowUp size={18} /></button></div>
      </div>
      <SupervisorGuidance learning={learning.data} />
      <details className="learning-settings">
        <summary><span>Learn from attempts <b>{session.experience?.enabled ? 'on' : 'off'}</b></span><span className="memory-count">{(session.experience?.stored ?? 0).toLocaleString()} memories <ChevronDown size={13} /></span></summary>
        <div className="learning-body"><label><input type="checkbox" checked={session.experience?.enabled ?? false} onChange={e => void command({ type: 'experience', enabled: e.target.checked })} /> Use past attempts in decisions</label><p>Relevant outcomes help guide Jev. Model weights stay unchanged.</p>{(session.experience?.stored ?? 0) > 0 && <button type="button" className="forget" title="Forget recorded experience; replay footage is kept" onClick={() => void command({ type: 'clear-experience' })}>Clear memories</button>}</div>
      </details>
      </div>
    </form></>}</aside></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
