import { useSoundtrack } from './use-soundtrack.ts';
import { SkillsPanel } from './skills-panel.tsx';
import { DecisionSettings } from './decision-settings.tsx';
import { PlanProgress } from './plan-progress.tsx';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, GitFork, Pause, Play, Volume2, VolumeX, ArrowUp, Gamepad2, Bot, ChevronDown, ChevronUp, History, GripHorizontal, Crosshair, Maximize2, SlidersHorizontal } from 'lucide-react';
import type { SessionView, WorldView } from '../../../packages/contracts/src/session.ts';
import type { Input } from '../../../packages/contracts/src/game.ts';
import './style.css';
import { RunPerformance } from './run-performance.tsx';
import { RunPanel } from './run-panel.tsx';
import { DecisionPanel } from './decision-panel.tsx';
import { RestartGame } from './restart.tsx';
import { useReplay } from './replay.tsx';
import { Director, directorWorlds, frameUrl } from './director.tsx';

function App() {
  const replay = useReplay();
  const [session, setSession] = useState<SessionView>();
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(localStorage.getItem('mom-selected') ?? '');
  const [follow, setFollow] = useState(localStorage.getItem('mom-follow') !== 'false');
  const [archives, setArchives] = useState(false);
  const [direction, setDirection] = useState('');
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
      socket = new WebSocket(`ws://${location.host}/api/events`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = event => setSession(JSON.parse(event.data));
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
  const selectedComparison = session.comparison?.selected && experiments.length === 0;
  const worlds = session.worlds.filter(w => archives || w.role !== 'archived' || selectedComparison && session.comparison?.candidateIds.includes(w.id));
  const countdown = session.reviewEndsAt ? Math.max(0, Math.ceil((session.reviewEndsAt - now) / 1000)) : undefined;
  const phaseIndex = session.stage === 'forking' || session.stage === 'exploring' ? 1 : comparing ? 2 : session.stage === 'continuing' ? 3 : 0;
  const phaseTitle = session.stage === 'acting' ? `${session.decision?.kind === 'plan' ? 'Following a plan' : 'Taking one action'}: ${session.decision?.action ?? 'playing'}` : session.stage === 'deciding' ? 'Jev is reading the game state' : session.stage === 'forking' ? session.decision?.mode === 'manual' ? 'You requested a comparison' : session.decision?.mode === 'stalled' ? 'Progress stalled. Testing alternatives.' : 'Jev is uncertain. Testing alternatives.' : session.stage === 'exploring' ? `Testing ${experiments.length} futures side by side` : comparing ? 'Which future worked best?' : session.stage === 'continuing' ? 'The winner becomes the main session' : session.running ? 'Jev is choosing the next approach' : 'Ready when you are';
  const phaseDetail = session.stage === 'acting' ? `${Math.round((session.confidence ?? 0) * 100)}% confidence. Continuing directly without a fork.` : session.stage === 'deciding' ? session.planningMode === 'plans' ? 'Ranking short plans from current game observations.' : 'Ranking actions from player, enemy, and projectile telemetry.' : session.stage === 'forking' ? session.decision?.mode === 'stalled' ? 'No useful progress for 10 game seconds. Comparing alternatives despite model confidence.' : `${Math.round((session.confidence ?? 0) * 100)}% confidence${session.decision?.mode === 'uncertain' ? `, below the ${Math.round((session.decision?.threshold ?? .75) * 100)}% threshold` : ''}. The main session waits here.` : session.stage === 'exploring' ? session.planningMode === 'plans' ? 'Same starting state. Different plans, with progress checked every tick.' : 'Same starting state. Different opening moves, then Jev steers each future.' : comparing ? session.comparison?.reason ?? 'Comparing the observed outcomes.' : session.stage === 'continuing' ? 'Only the chosen future continues. The other results stay below.' : session.manualChoiceRequired ? 'Manual play changed the comparison. Choose a world to continue.' : 'Resume to watch the loop, or explore one decision at a time.';
  const worldCard = (world: WorldView) => <button key={world.id} className={`world ${world.id === focused.id ? 'selected' : ''} ${world.role === 'main' ? 'main-world' : ''} ${session.comparison?.bestId === world.id ? 'best-world' : ''} ${world.role === 'archived' ? 'not-selected' : ''}`} onClick={() => inspect(world.id)}>
    <div className="world-top"><span>{world.role === 'main' ? 'main session' : world.role === 'archived' ? 'not selected' : `future ${session.worlds.filter(w => w.generation === world.generation).indexOf(world) + 1}`} <small>· g{world.generation}</small></span><span className="muted">{world.thinking ? 'choosing next approach…' : world.role === 'archived' ? 'final frame' : `${world.status} · ${world.controller === 'human' ? 'you' : 'AI'}`}</span></div>
    <div className="world-body"><img src={frameUrl(world)} alt={`${world.label} gameplay`} /><div><strong>{world.plan?.label ?? world.label}</strong>{session.comparison?.bestId === world.id && <span className="outcome-badge">{session.comparison.selected ? 'chosen future' : 'best outcome'}</span>}{world.plan ? <PlanProgress plan={world.plan} /> : world.role === 'experiment' && world.currentAction && <p>now: {world.currentAction}</p>}<p>health {world.state.health} · ammo {world.state.ammo[0]} · {world.state.kills} map kills</p>{world.trial && <p className="trial-result">{world.trial.healthChange >= 0 ? '+' : ''}{world.trial.healthChange} health · +{world.trial.kills} kills this trial · {world.trial.distance} units moved</p>}{world.role === 'experiment' && world.trial && <div className="trial-progress"><span>{(world.trial.elapsed / 35).toFixed(1)} / {(world.trial.total / 35).toFixed(1)}s tested</span><div className="probability"><span style={{ width: `${Math.min(100, world.trial.elapsed / world.trial.total * 100)}%` }} /></div></div>}</div></div>
  </button>;
  return <div className="app">
    <header><div className="brand"><GitFork /><span>microsandbox</span></div><div className="title"><h1>multiverse of madness</h1><span>microsandbox × Jev <i className={connected ? 'online' : ''} /> {connected ? 'connected' : 'reconnecting'}</span></div><div className="controls"><details className="play-settings"><summary className="icon" aria-label="Playback settings" title="Playback settings"><SlidersHorizontal /></summary><div><div className="audio-settings"><strong>soundtrack</strong><label><input type="checkbox" checked={soundtrack.music} onChange={e => soundtrack.setMusic(e.target.checked)} /> adaptive music</label><label><input type="checkbox" checked={soundtrack.effects} onChange={e => soundtrack.setEffects(e.target.checked)} /> event sounds</label><p>Parallel Afterglow · original electronic score. Use the speaker to enable audio.</p></div><DecisionSettings session={session} command={command} /><label htmlFor="winner-delay">continue with winner after</label><select id="winner-delay" aria-label="Winner review delay" value={session.winnerDelaySeconds ?? 0} onChange={e => void command({ type: 'winner-delay', seconds: Number(e.target.value) })}>{[0, 1, 2, 3, 5, 10, 15, 30, 60].map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? 'immediately' : `${seconds} seconds`}</option>)}</select><p>Zero skips the review pause. You can still inspect outcomes in replay.</p><label htmlFor="planning-mode">decision style</label><select id="planning-mode" value={session.planningMode ?? 'plans'} onChange={e => void command({ type: 'planning-mode', mode: e.target.value })}><option value="plans">short conditional plans</option><option value="actions">single actions</option></select><p>Plans advance on observed conditions. Jev reassesses on completion, danger or failure. Changes apply to the next decision.</p><label htmlFor="decision-interval">single-action interval</label><select id="decision-interval" disabled={session.planningMode !== 'actions'} aria-label="Jev decision interval" value={session.decisionIntervalTicks ?? 35} onChange={e => void command({ type: 'decision-interval', ticks: Number(e.target.value) })}>{[7, 14, 35, 70, 105, 210].map(ticks => <option key={ticks} value={ticks}>{ticks / 35} game seconds · {ticks} ticks</option>)}</select><p>Used in single-action mode. Plans check their conditions every game tick.</p><label htmlFor="trial-duration">compare futures after</label><select id="trial-duration" aria-label="Trial gameplay duration" value={session.trialDurationTicks ?? 210} onChange={e => void command({ type: 'trial-duration', ticks: Number(e.target.value) })}>{[1, 2, 3, 6, 10, 15, 30, 60].map(seconds => <option key={seconds} value={seconds * 35}>{seconds} game {seconds === 1 ? 'second' : 'seconds'}</option>)}</select><p>Applies to the next batch. Current futures keep their original trial length.</p></div></details>{icon('Replay full session', <History />, () => replay.open(session.mainId), replay.enabled, !replay.available)}<RestartGame restart={async () => { const ok = await command({ type: 'restart', confirm: true }); if (ok) { replay.close(); setFollow(true); setSelected(''); } return ok; }} /><label className="follow"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> auto director</label><div className="playback">{icon(session.running || session.busy || humanPlaying ? 'Pause session' : 'Resume AI play', session.running || session.busy || humanPlaying ? <Pause /> : <Play />, () => void command({ type: session.running || session.busy || humanPlaying ? 'pause' : 'resume' }), true)}{icon(sound ? 'Mute sounds' : 'Enable sounds', sound ? <Volume2 /> : <VolumeX />, () => { void soundtrack.toggle().catch(e => setError(e instanceof Error ? e.message : 'Audio unavailable')); })}{sound && <input className="volume" aria-label="Sound volume" type="range" min="0" max="0.4" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} />}</div>{icon(session.stage === 'choosing' ? 'Select best outcome' : 'Explore next futures', <GitFork />, () => void command({ type: 'step' }), false, session.running || session.busy || Boolean(session.manualChoiceRequired))}</div></header>
    {replay.recordingError && <div className="error" role="status">{replay.recordingError}</div>}
    {(error || session.error) && <div className="error" role="alert">{error || session.error}<button onClick={() => setError('')}>×</button></div>}
    <RunPerformance session={session} />
    <main><section className="focus"><div className={`player ${directing ? 'directing' : ''}`} ref={player} tabIndex={0} aria-label="Focused game screen">{directing && <Director session={session} onFocus={inspect} now={now} />}<div className="single-view" hidden={directing}><img className="game-frame" src={replay.enabled ? replay.record ? `data:image/png;base64,${replay.record.frame}` : undefined : frameUrl(focused)} alt={replay.enabled ? "Recorded game state" : "Live game state"} style={{ visibility: replay.enabled && !replay.record ? "hidden" : "visible" }} /><div className="player-top"><span><i className={focused.status === 'running' ? 'online' : ''} /> {replay.enabled ? 'recorded world · read only' : focused.role === 'main' ? experiments.length ? 'main session · waiting for futures' : 'main session' : focused.label}</span><span>{replay.enabled ? 'replay' : focused.thinking ? 'choosing next approach…' : `${focused.status} · ${focused.controller === 'human' ? 'you' : 'AI'}`}</span></div>{!follow && !replay.enabled && <button className="resume-director" onClick={() => setFollow(true)}>resume auto director</button>}
      {!replay.enabled && <div ref={overlay} className={`commentary ${collapsed ? 'collapsed' : ''}`} style={{ left: `min(${position.x}px, calc(100% - 280px))`, top: `min(${position.y}px, calc(100% - 100px))` }}><div className="commentary-head" onPointerDown={drag}><GripHorizontal size={16} /><span>session commentary</span>{icon('Commentary history', <History size={15} />, () => setHistory(!history), history)}{icon(collapsed ? 'Expand commentary' : 'Collapse commentary', collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />, () => setCollapsed(!collapsed))}</div>{!collapsed && <div className="commentary-body">{(history ? comments.slice(-10) : comments.slice(-1)).map(c => <p key={c.id}>{c.text}</p>)}{!comments.length && <p>Watching this world. Waiting for its next event.</p>}</div>}</div>}
      {replay.panel}<div className="player-bottom"><div><h2>{displayed?.plan?.label ?? displayed?.currentAction ?? displayed?.label ?? "loading recording…"}</h2><PlanProgress plan={displayed?.plan} /><span>health {displayed?.state.health ?? "…"} · ammo {displayed?.state.ammo[0] ?? "…"} · {displayed?.state.kills ?? "…"} map kills · tick {displayed?.state.tick ?? "…"}</span></div><div className="world-controls">{!replay.enabled && focused.role !== 'archived' && focused.state.alive && <button className="secondary" onClick={() => void command({ type: focused.controller === 'human' ? 'release' : 'takeover', worldId: focused.id })}>{focused.controller === 'human' ? <Bot size={18} /> : <Gamepad2 size={18} />}{focused.controller === 'human' ? 'return to AI' : 'take control'}</button>}{!replay.enabled && (focused.role === 'experiment' || session.manualChoiceRequired && focused.role === 'main') && focused.state.alive && <button className="primary" disabled={session.busy} onClick={() => void command({ type: 'promote', worldId: focused.id })}>continue from here</button>}{icon(replay.enabled ? 'Return to live' : 'Replay recorded worlds', <History size={18} />, () => replay.enabled ? replay.close() : replay.open(focused.id), replay.enabled, !replay.available)}{icon('Fullscreen player', <Maximize2 size={18} />, () => void player.current?.requestFullscreen())}</div></div>
      {!replay.enabled && focused.controller === 'human' && <div className="key-help">WASD move · ← → turn · space fire · E use</div>}
    </div></div></section><aside><div className="sidebar-head"><span>{session.stage === 'forking' ? 'creating futures…' : session.stage === 'exploring' ? 'exploring futures' : session.stage === 'choosing' ? 'compare outcomes' : `AI loop ${session.running ? 'running' : 'paused'}`}</span>{icon(archives ? 'Hide archived worlds' : 'Show archived worlds', <Archive size={18} />, () => setArchives(!archives), archives)}</div><div className="phase-panel"><div className="phase-steps">{['choose', 'explore', 'compare', 'continue'].map((name, index) => <span key={name} className={phaseIndex === index ? 'current' : ''}>{index + 1} {name}</span>)}</div><strong>{phaseTitle}</strong><p>{phaseDetail}</p>{countdown !== undefined && <span className="review-countdown">Continuing with the winner in {countdown}s · pause to inspect</span>}</div><div className="worlds"><RunPanel session={session} command={command} restored={() => { replay.close(); setFollow(true); setSelected(''); }} /><DecisionPanel session={session} />{worlds.filter(w => w.role === 'main').map(worldCard)}{selectedComparison && <div className="results-label">last alternatives · kept for comparison</div>}<div className="world-grid">{worlds.filter(w => w.role !== 'main').map(worldCard)}</div></div><SkillsPanel session={session} command={command} /><form className="composer" onSubmit={e => { e.preventDefault(); if (direction.trim()) { void command({ type: 'direction', text: direction }); setDirection(''); } }}><div className="experience-control"><label><input type="checkbox" checked={session.experience?.enabled ?? false} onChange={e => void command({ type: 'experience', enabled: e.target.checked })} /> learn from attempts</label><span title="Measured action outcomes, including discarded futures. Relevant records are passed as context; model weights do not change.">{session.experience?.stored ?? 0} remembered</span>{(session.experience?.stored ?? 0) > 0 && <button className="forget" title="Forget recorded experience; replay footage is kept" onClick={() => void command({ type: 'clear-experience' })}>clear</button>}</div><div className="composer-title"><h3>guide the AI</h3><span title="Applies to all worlds at the next decision">next decision</span></div><p className="objective"><Crosshair size={14} />{session.pendingObjective ? `queued: ${session.pendingObjective}` : session.objective}</p><div className="input-wrap"><textarea aria-label="Direction for AI" placeholder="e.g. find health before fighting…" value={direction} onChange={e => setDirection(e.target.value)} maxLength={1000} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} /><button className="send primary" aria-label="Send direction" disabled={!direction.trim()}><ArrowUp /></button></div></form></aside></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
