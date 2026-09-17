import { PlanProgress } from './plan-progress.tsx';
import type { SessionView, WorldView } from '../../../packages/contracts/src/session.ts';

export const frameUrl = (world: WorldView) => `/api/frame/${encodeURIComponent(world.id)}?v=${world.frameVersion}`;

/** Only authoritative lifecycle stages drive automatic camera changes. */
export function directorWorlds(session: SessionView): WorldView[] {
  const ids = session.directorWorldIds ?? session.comparison?.candidateIds;
  if (ids?.length) return ids.flatMap(id => { const world = session.worlds.find(w => w.id === id); return world ? [world] : []; });
  const experiments = session.worlds.filter(w => w.role === 'experiment');
  if (experiments.length) return experiments;
  return [];
}

function outcome(world: WorldView, session: SessionView) {
  if (world.thinking) return 'choosing next approach…';
  if (!world.state.alive) return 'died · final frame';
  if (world.role === 'archived') return 'not selected · final frame';
  if (world.id === session.mainId) return `main session · ${session.stage === 'deciding' ? 'choosing next move' : world.status}`;
  if (world.trial && world.trial.elapsed >= world.trial.total) return 'trial complete';
  return world.status === 'running' ? 'exploring' : 'paused';
}

export function Director({ session, onFocus, now }: { session: SessionView; onFocus: (id: string) => void; now: number }) {
  const worlds = directorWorlds(session);
  const continuing = worlds.some(w => w.id === session.mainId);
  const preparing = session.stage === 'forking' && continuing;
  const source = session.worlds.find(w => w.id === (worlds[0]?.parentId ?? session.mainId));
  const countdown = session.reviewEndsAt ? Math.max(0, Math.ceil((session.reviewEndsAt - now) / 1000)) : undefined;
  return <div className={`director ${continuing ? 'continuing' : ''}`}>
    <div className="director-heading"><div><span className="director-eyebrow">{continuing ? 'chosen path · same view' : 'one moment · different approaches'}</span><h2>{preparing ? 'Creating the next futures…' : continuing ? 'The chosen world continues here' : session.stage === 'choosing' ? 'See how each approach ended' : worlds.length ? `Trying ${worlds.length} futures` : 'Creating alternate futures…'}</h2><p>{continuing ? session.comparison?.reason ?? 'The highlighted world is main. Other panes retain the previous outcomes.' : session.stage === 'choosing' ? session.comparison?.reason ?? 'No surviving future. The starting world is preserved.' : session.planningMode === 'plans' ? 'Each future tests a short plan. Watch its steps unfold; Jev reassesses when needed.' : 'Same starting state. Jev makes new decisions as each future unfolds.'}</p></div>{source && <div className="checkpoint-preview"><img src={frameUrl(source)} alt="Starting world, paused during exploration" /><span>started here · paused</span></div>}</div>
    <div className="director-grid" style={{ '--world-count': worlds.length } as React.CSSProperties}>
      {!worlds.length && <div className="director-wait" role="status">Capturing the starting world and creating independent sandboxes…</div>}
      {worlds.map((world, index) => <button key={world.id} className={`future-screen ${world.id === session.mainId || session.comparison?.bestId === world.id ? 'winner' : ''} ${!world.state.alive ? 'failed' : ''}`} onClick={() => onFocus(world.id)} aria-label={`Inspect future ${index + 1}: ${world.label}`}>
        <img src={frameUrl(world)} alt={`${world.label} ${world.status === 'running' ? 'live gameplay' : 'final or paused frame'}`} />
        <div className="future-heading"><strong>{world.plan?.label ?? world.label}</strong><span>{outcome(world, session)}</span></div>
        <div className="future-caption">{!world.plan && <strong>{world.id === session.mainId ? world.currentAction ?? 'main session' : session.comparison?.bestId === world.id ? 'best measured outcome' : world.currentAction ?? world.label}</strong>}<PlanProgress plan={world.plan} /><span>health {world.state.health} · {world.state.kills} map kills{world.trial ? ` · ${world.trial.healthChange < 0 ? `lost ${-world.trial.healthChange}` : `gained ${world.trial.healthChange}`} health · +${world.trial.kills} this trial` : ''}</span>{world.trial && <div className="future-progress"><span style={{ width: `${Math.min(100, world.trial.elapsed / world.trial.total * 100)}%` }} /></div>}<small>{world.trial ? `${(world.trial.elapsed / 35).toFixed(1)}s explored` : ''} · click to inspect</small></div>
      </button>)}
    </div>
    <div className="director-footer" role="status">{continuing ? 'The highlighted world is main. Click any pane to inspect; the next futures will replace this batch.' : countdown !== undefined ? `Continuing with the winner in ${countdown}s · pause to inspect` : !session.running && !session.busy ? 'Session paused · inspect any future or resume to continue' : 'Watch all futures, or click one to hold your focus there.'}</div>
  </div>;
}
