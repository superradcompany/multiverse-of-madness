import { StrategyPanel } from './strategy-panel.tsx';
import { useState } from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import type { SessionView, WorldView } from '../../contracts/src/session.ts';
import { DecisionPanel } from './decision-panel.tsx';
import { PlanProgress } from './plan-progress.tsx';
import { RunPanel } from './run-panel.tsx';

export function LiveSidebar({ session, focused, directing, phaseTitle, phaseDetail, countdown, inspect, command, restored }: {
  session: SessionView; focused: WorldView; directing: boolean; phaseTitle: string; phaseDetail: string;
  countdown?: number; inspect: (id: string) => void; command: (data: object) => Promise<boolean>; restored: () => void;
}) {
  const [archives, setArchives] = useState(false);
  const completed = session.comparison?.selected && !session.worlds.some(w => w.role === 'experiment');
  const alternatives = session.worlds.filter(w => w.id !== focused.id && (archives || w.role !== 'archived' || completed && session.comparison?.candidateIds.includes(w.id)));
  const status = session.error ? 'Run paused' : phaseTitle;
  return <>
    {!directing && <details className="phase-status">
      <summary><i className={session.running ? 'online' : ''} /><span>{status}</span><ChevronDown size={14} /></summary>
      <p>{session.error ? 'Resolve the session error before resuming play.' : phaseDetail}</p>
    </details>}
    {countdown !== undefined && <span className="review-countdown">Continuing in {countdown}s · pause to inspect</span>}
    <div className="worlds context-panels">
      {!directing && <>
        <section className="focused-context" aria-label="Focused world progress">
          <div className="context-eyebrow"><span>{focused.role === 'main' ? 'Main session' : focused.role === 'archived' ? 'Archived future' : 'Exploring future'} · g{focused.generation}</span><span>{focused.thinking ? 'thinking' : focused.status} · {focused.controller === 'human' ? 'you' : 'AI'}</span></div>
          <h2>{focused.plan?.label ?? focused.currentAction ?? focused.label}</h2>
          <PlanProgress plan={focused.plan} judging={session.stage === 'choosing' && focused.role === 'experiment'} />
          {focused.trial && <><div className="focused-trial"><span>{(focused.trial.elapsed / 35).toFixed(1)} / {(focused.trial.total / 35).toFixed(1)}s explored</span><span>{focused.trial.healthChange >= 0 ? '+' : ''}{focused.trial.healthChange} health · +{focused.trial.kills} kills</span></div><progress aria-label="Trial progress" value={focused.trial.elapsed} max={focused.trial.total} /></>}
        </section>
        <section className="world-switcher" aria-label="Other worlds">
          <div className="switcher-heading"><h3>Other futures <span>{alternatives.length}</span></h3><button className={`icon ${archives ? 'active' : ''}`} aria-label={archives ? 'Hide archived worlds' : 'Show archived worlds'} aria-pressed={archives} title={archives ? 'Hide archived worlds' : 'Show archived worlds'} onClick={() => setArchives(!archives)}><Archive size={16} /></button></div>
          {alternatives.length ? alternatives.map(world => <button key={world.id} className="world-shortcut" onClick={() => inspect(world.id)} aria-label={`Watch ${world.role === 'main' ? 'main session' : 'future'}: ${world.plan?.label ?? world.label}`}><div><strong>{world.plan?.label ?? world.label}</strong><span>{world.role === 'main' ? 'Main session' : `g${world.generation} · ${world.role === 'archived' ? 'archived' : 'future'}`} · {world.thinking ? 'thinking' : world.status}{session.comparison?.bestId === world.id ? ' · best outcome' : ''}</span></div><ChevronRight size={15} /></button>) : <p>No other futures yet.</p>}
        </section>
      </>}
      <DecisionPanel session={session} />
      <section className="session-details-card" aria-label="Plans, performance and checkpoints">
        <StrategyPanel world={focused} />
        <RunPanel session={session} command={command} restored={restored} />
      </section>
    </div>
  </>;
}
