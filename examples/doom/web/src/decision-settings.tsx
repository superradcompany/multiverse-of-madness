import type { SessionView } from '../../contracts/src/session.ts';

export function DecisionSettings({ session, command }: { session: SessionView; command: (body: Record<string, unknown>) => Promise<unknown> }) {
  const capacity = session.experience?.capacity ?? 128, perDecision = session.experience?.contextLimit ?? 2;
  return <>
    <label htmlFor="max-futures">maximum futures per decision</label>
    <select id="max-futures" value={session.maxFutures ?? 4} onChange={e => void command({ type: 'max-futures', count: Number(e.target.value) })}>{Array.from({ length: 9 }, (_, i) => i + 2).map(n => <option key={n} value={n}>{n} futures{n === 4 ? ' (default)' : ''}</option>)}</select>
    <p>The supervisor can choose fewer futures within this cap. The next decision targets {session.effectiveFutures ?? session.maxFutures ?? 4}, up to the number of valid plans. Larger batches use more memory and model calls.</p>
    <label htmlFor="fork-threshold">fork below {Math.round((session.forkThreshold ?? .75) * 100)}% confidence</label>
    <input id="fork-threshold" aria-label="Fork confidence threshold" type="range" min="0" max="100" step="1" value={Math.round((session.forkThreshold ?? .75) * 100)} onChange={e => void command({ type: 'fork-threshold', threshold: Number(e.target.value) / 100 })} />
    <p>Higher values test more alternatives. No useful progress for 10 game seconds also triggers a comparison, regardless of confidence.</p>
    <label htmlFor="memory-capacity">remember up to</label>
    <select id="memory-capacity" value={capacity} onChange={e => void command({ type: 'memory-settings', capacity: Number(e.target.value), perDecision })}>{[...new Set([8, 16, 32, 64, 128, 256, 512, 1024, capacity])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n} attempts</option>)}</select>
    <label htmlFor="memory-context">use per decision</label>
    <select id="memory-context" value={perDecision} onChange={e => void command({ type: 'memory-settings', capacity, perDecision: Number(e.target.value) })}>{Array.from({ length: 8 }, (_, i) => i + 1).map(n => <option key={n} value={n}>up to {n} relevant {n === 1 ? 'attempt' : 'attempts'}</option>)}</select>
    <p>{session.experience?.enabled ? 'Only relevant attempts are included, within the input budget. Decision details show the actual count.' : 'Learning is off. Enable “learn from attempts” below the worlds to send these memories to Jev.'}</p>
  </>;
}
