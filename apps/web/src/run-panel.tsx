import { useState } from 'react';
import { BookmarkPlus, RotateCcw, Trash2 } from 'lucide-react';
import type { RecoveryPolicy, SessionView } from '../../../packages/contracts/src/session.ts';

export function RunPanel({ session, command, restored }: { session: SessionView; command: (data: object) => Promise<boolean>; restored: () => void }) {
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const s = session.stats, recovery = session.recovery;
  if (!s || !recovery) return null;
  const run = async (data: object) => { setPending(true); try { return await command(data); } finally { setPending(false); } };
  const policy = (patch: Partial<RecoveryPolicy>) => void run({ type: 'recovery-policy', ...recovery.policy, ...patch });
  return <section className="run-panel" aria-label="Run statistics and recovery">
    <details className="run-details"><summary>performance details <span>{s.attempts.retries} retries · {s.attempts.rollbacks} rollbacks</span></summary>
      <dl><dt>Items / secrets</dt><dd>{s.items} / {s.secrets}</dd><dt>Ammo · bullets / shells / cells / rockets</dt><dd>{s.ammo.join(' / ')}</dd><dt>Health lost / recovered</dt><dd>{s.damage} / {s.healing}</dd><dt>Ammo spent</dt><dd>{s.ammoSpent}</dd><dt>Areas visited</dt><dd>{s.cells}</dd><dt>All worlds · kills / deaths</dt><dd>{s.attempts.kills} / {s.attempts.deaths}</dd><dt>All worlds · simulated time</dt><dd>{s.attempts.seconds.toFixed(1)}s</dd><dt>Poor batches rejected</dt><dd>{s.attempts.rejectedBatches}</dd></dl>
      <p>Main totals follow the chosen route, across levels. A future’s kills join the main total only when it is selected. Rollback restores the saved total. All-world counters include abandoned attempts. Kills use Doom’s level counter, which counts eligible monsters and can include monster infighting.</p>
      {s.partial && <p>Older run: current-map kills are included; time, damage and attempt counters start when tracking was added.</p>}
    </details>
    <details className="run-details recovery-controls"><summary>checkpoints <span>{recovery.checkpoints.length}/3 saved{recovery.policy.enabled ? ' · auto recovery on' : ''}</span></summary>
      <button className="secondary checkpoint-save" disabled={pending || !session.worlds.find(w => w.id === session.mainId)?.state.alive} onClick={() => void run({ type: 'checkpoint-save' })}><BookmarkPlus size={15} />save checkpoint</button>
      <p>Saving pauses play. Restoring keeps recordings and experience. Three checkpoints stay selectable. Required ancestors are kept until their descendants are removed.</p>
      <div className="checkpoint-list">{[...recovery.checkpoints].reverse().map(p => <div key={p.id} className="checkpoint-entry"><span>{p.map} · {(p.tick / 35).toFixed(1)}s<small>{p.health} health · {p.kills} kills</small></span><button className="icon" title="Restore checkpoint" aria-label={`Restore checkpoint at ${(p.tick / 35).toFixed(1)} seconds`} disabled={pending} onClick={() => setConfirm(p.id)}><RotateCcw size={16} /></button><button className="icon" title="Delete checkpoint" aria-label={`Delete checkpoint at ${(p.tick / 35).toFixed(1)} seconds`} disabled={pending} onClick={() => void run({ type: 'checkpoint-delete', checkpointId: p.id })}><Trash2 size={15} /></button></div>)}</div>
      {confirm && <div className="rollback-confirm"><p>Return to this checkpoint and pause? Current futures will be archived.</p><button disabled={pending} onClick={async () => { if (await run({ type: 'rollback', checkpointId: confirm })) { setConfirm(undefined); restored(); } }}>restore</button><button onClick={() => setConfirm(undefined)}>cancel</button></div>}
      <label className="recovery-toggle"><input type="checkbox" disabled={pending} checked={recovery.policy.enabled} onChange={e => policy({ enabled: e.target.checked })} /> automatically recover poor runs</label>
      {recovery.policy.enabled && <div className="recovery-policy"><label>retry poor batches<select aria-label="Poor batch retries" disabled={pending} value={recovery.policy.maxRetries} onChange={e => policy({ maxRetries: Number(e.target.value) })}>{[0, 1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n} {n === 1 ? 'retry' : 'retries'}</option>)}</select></label><label>reject health loss of<select aria-label="Recovery health loss" disabled={pending} value={recovery.policy.healthLoss} onChange={e => policy({ healthLoss: Number(e.target.value) })}>{[5, 10, 15, 25, 50, 100].map(n => <option key={n} value={n}>{n} or more</option>)}</select></label><label>reject no progress for<select aria-label="Recovery stall duration" disabled={pending} value={recovery.policy.stallSeconds} onChange={e => policy({ stallSeconds: Number(e.target.value) })}>{[5, 10, 15, 30, 60, 120].map(n => <option key={n} value={n}>{n} game seconds</option>)}</select></label><p>Health loss is measured from the checkpoint or trial start, whichever was healthier. Retries keep the source unchanged and rotate available opening moves. After the budget is exhausted, restore the latest checkpoint and pause. Direct-play death also restores it. New checkpoints are saved at healthy progress milestones, at least 30 game seconds apart.</p></div>}
      {recovery.message && <p role="status">{recovery.message}</p>}
    </details>
  </section>;
}
