import type { SessionView } from '../../contracts/src/session.ts';

/** The live main timeline stays visible even while inspecting a future or replay. */
export function RunPerformance({ session }: { session: SessionView }) {
  const stats = session.stats;
  if (!stats) return null;
  const main = session.worlds.find(world => world.id === session.mainId);
  const time = `${Math.floor(stats.seconds / 60)}:${Math.floor(stats.seconds % 60).toString().padStart(2, '0')}`;
  const metrics = [
    { label: 'total kills', value: stats.kills },
    { label: 'current health', value: stats.health },
    { label: 'current armor', value: stats.armor },
    { label: 'items collected', value: stats.items },
    { label: 'secrets found', value: stats.secrets },
    { label: 'levels cleared', value: stats.levels },
    { label: stats.partial ? 'tracked play time' : 'game time', value: time },
  ];
  return <section className="run-performance" aria-label="Overall run performance">
    <div className="performance-heading"><h2>run performance</h2><span title="Cumulative totals across the chosen route. Discarded futures do not add to these totals. Rollback restores the selected route's totals.">main run{main ? ` · E${main.state.episode}M${main.state.map}` : ''}{stats.partial && <small title="This run predates detailed tracking. Current-map kills, items and secrets are included; earlier time, damage and completed levels may be missing."> · partial history</small>}</span></div>
    <dl>{metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
  </section>;
}
