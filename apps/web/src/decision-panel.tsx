import type { SessionView } from '../../../packages/contracts/src/session.ts';

export function DecisionPanel({ session }: { session: SessionView }) {
  const decision = session.decision;
  if (!decision?.preferences) return null;
  const confidence = (session.confidence ?? 0) * 100;
  const threshold = decision.threshold * 100;
  const branching = decision.mode !== 'direct';
  const tested = decision.preferences.filter(p => p.tested).length;
  const chosen = session.comparison?.selected ? session.worlds.find(w => w.id === session.comparison?.bestId) : undefined;
  return <section className={`decision-panel ${branching ? 'split' : 'direct'}`} aria-label="Why this decision">
    <div className="decision-heading"><span>{session.stage === 'deciding' ? 'previous decision' : 'decision signal'}</span><strong>{branching ? `${tested} futures` : '1 world'}</strong></div>
    <div className="confidence-label"><span title="How concentrated Jev’s preferences are, not the chance of success">Jev confidence <b>{confidence.toFixed(0)}%</b></span><span>fork below {threshold.toFixed(0)}%</span></div>
    <div className="confidence-track" role="meter" aria-label="Jev confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={confidence}>
      <span style={{ width: `${confidence}%` }} /><i style={{ left: `${threshold}%` }} />
    </div>
    <p>{decision.mode === 'manual' ? 'Manual comparison · confidence rule bypassed.' : decision.mode === 'stalled' ? 'No useful progress for 10 game seconds → test alternatives.' : branching ? 'Below the threshold → test alternatives.' : 'At or above the threshold → act directly.'}</p>
    <p className="decision-note">Preference certainty, not survival odds · {threshold.toFixed(0)}% is an uncalibrated routing threshold.</p>
    <details key={`${decision.sourceId}-${decision.tick}`}>
      <summary>{decision.kind === 'plan' ? 'Plan preferences' : 'Action preferences'} <span>{decision.preferences[0]?.action} · {((decision.preferences[0]?.probability ?? 0) * 100).toFixed(0)}%</span></summary>
      <div className="preference-list">{decision.preferences.map(p => <div className="preference" key={p.action}>
        <div><span>{p.action}{p.tested && <small>testing</small>}</span><b>{(p.probability * 100).toFixed(0)}%</b></div>
        <div className="preference-track"><span style={{ width: `${p.probability * 100}%` }} /></div>
      </div>)}</div>
      <p className="decision-note">Preferences among the available approaches, not survival odds. Confidence measures how concentrated they are. The threshold is experimental.</p>
      <p className="decision-note">{session.experience?.used ?? 0} related attempts supplied to this decision.</p>
      {decision.perception && <p className="decision-note">Map checks: {decision.perception.blockedEnemies} enemies behind solid geometry; {decision.perception.uncertainTargets} targets across uncertain openings. Nearest forward barrier: {decision.perception.forwardBarrier} units. {decision.perception.movementFailed ? 'Previous movement made no progress. ' : ''}Firing and aim assistance enabled; moving doors are not verified.</p>}
      <p className="decision-note">Tick {decision.tick} · Jev {Math.round(decision.latencyMs ?? 0)} ms</p>
    </details>
    {decision.evidence && <details className="memory-evidence"><summary>Context sent to Jev</summary>
      <p className="decision-note">Guide: {decision.evidence.objective}</p>
      <p className="decision-note">Skills supplied: {decision.evidence.skills?.map(s => s.name).join(", ") || "none"}.</p>
      {decision.evidence.skills?.map(skill => <details key={skill.id}><summary>{skill.name}</summary><p className="skill-instructions">{skill.instructions}</p></details>)}
      <p className="decision-note">Health {decision.evidence.stats.current.health} · armor {decision.evidence.stats.current.armor} · {decision.evidence.stats.current.mapKills} map kills · {decision.evidence.stats.route.kills} route kills · {decision.evidence.stats.route.exploredCells} explored cells.</p>
      <p className="decision-note">{decision.evidence.stats.progress.secondsWithoutProgress}s without progress · {decision.evidence.experienceUsed} relevant attempts supplied. Full ammo and route statistics accompany every question.</p>
    </details>}
    {!!session.experience?.evidence?.length && <details className="memory-evidence"><summary>Experience supplied to Jev · {session.experience.evidence.length}</summary>{session.experience.evidence.map((e, i) => <p className="decision-note" key={i}>{e.action}: {e.health >= 0 ? '+' : ''}{e.health} health, {e.kills} new kills, {e.moved} units moved in {(e.ticks / 35).toFixed(1)}s{e.died ? ' · died' : ''}.</p>)}</details>}
    {chosen && <p className="decision-outcome">Observed choice: {chosen.label}{chosen.label === decision.action ? ' · kept Jev’s first choice' : ' · changed Jev’s first choice'}</p>}
    {session.routing && <div className="routing-totals" title="Recorded since decision tracking began; includes requested decisions, even if execution was interrupted."><span>{session.routing.direct} direct</span><span>{session.routing.uncertain} uncertainty forks</span>{!!session.routing.stalled && <span>{session.routing.stalled} stalled-progress forks</span>}{session.routing.manual > 0 && <span>{session.routing.manual} manual</span>}</div>}
  </section>;
}
