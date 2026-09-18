import { useRef, useState } from 'react';
import { Server, X } from 'lucide-react';
import type { SessionView } from '../../../packages/contracts/src/session.ts';
import type { VmOverview, VmResourceState, VmPlan, VmSettings } from '../../../packages/contracts/src/vm.ts';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'VM request failed');
  return result;
}
const fields = [ ['cpus', 'vCPUs', 1, 32], ['memory', 'Memory (MiB)', 256, 65536], ['rootDiskSize', 'Root disk (MiB)', 2048, 131072], ['maxCpus', 'CPU ceiling at boot', 1, 32], ['maxMemory', 'Memory ceiling at boot (MiB)', 256, 65536] ] as const;
export function VmSettingsPanel({ session, focusedId }: { session: SessionView; focusedId?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<VmOverview>();
  const [settings, setSettings] = useState<VmSettings>();
  const [target, setTarget] = useState('defaults');
  const [resources, setResources] = useState<VmResourceState>();
  const [plan, setPlan] = useState<VmPlan>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const load = async (preferred = target) => {
    const value = await request<VmOverview>('/api/vms'); setData(value); setSettings(value.settings);
    const world = value.worlds.find(w => w.id === preferred);
    setTarget(world?.id ?? 'defaults'); setResources(world?.resources ?? value.settings.defaults);
  };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const choose = (id: string) => { setTarget(id); setResources(id === 'defaults' ? settings?.defaults : data?.worlds.find(w => w.id === id)?.resources); setPlan(undefined); setMessage(''); setError(''); };
  const modify = (dryRun: boolean) => run(async () => {
    const result = await request<VmPlan>('/api/vms/modify', { worldId: target, resources, dryRun }); setPlan(result);
    if (!dryRun) { await load(); setMessage(result.applied ? 'Modification accepted. Check convergence below for actual CPU and memory.' : 'No changes applied. See the plan below.'); }
  });
  const canApply = plan && !plan.applied && !plan.conflicts.length && plan.changes.length > 0 && plan.changes.every(c => c.disposition === 'live');
  return <>
    <button className="icon" aria-label="VM resources" title="VM resources" aria-haspopup="dialog" onClick={() => { dialog.current?.showModal(); setPlan(undefined); void run(() => load(focusedId)); }}><Server /></button>
    <dialog ref={dialog} className="skills-dialog vm-dialog" aria-labelledby="vm-heading">
      <div className="skills-heading"><h2 id="vm-heading">VM resources</h2><button type="button" className="icon" aria-label="Close VM resources" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      {data && settings && resources && <>
        <div className="vm-summary"><strong>{data.worlds.length} resident VMs</strong><span>{data.totals.cpus} configured vCPUs · {data.totals.memory} MiB memory</span></div>
        <p>Includes the source world and all resident futures. These are configured allocations, not measured usage.</p>
        <label className="vm-target">Configure<select disabled={busy} value={target} onChange={e => choose(e.target.value)}><option value="defaults">Defaults for new games</option>{data.worlds.map(w => <option key={w.id} value={w.id}>{w.role === 'main' ? 'Main session' : w.label} · {w.id}</option>)}</select></label>
        <p>{target === 'defaults' ? 'Saved defaults apply when you restart the game. Forks and restored checkpoints inherit their source VM configuration.' : 'Pause gameplay to preview or apply an override. Only changes the runtime supports without a restart can be applied here.'}</p>
        {target !== 'defaults' && resources.rootDiskSize === undefined && <p>The snapshot retained its root disk. Its creation-time size is not reported; leave the disk field blank to keep it unchanged.</p>}<div className="vm-fields">{fields.map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step="1" disabled={busy} value={resources[key] ?? ''} placeholder={key === 'rootDiskSize' ? 'Retained checkpoint capacity' : undefined} onChange={e => { setResources({ ...resources, [key]: key === 'rootDiskSize' && e.target.value === '' ? undefined : Number(e.target.value) }); setPlan(undefined); setMessage(''); }} /></label>)}</div>
        {target === 'defaults' && <><h3>Session budget</h3><p>Limits total configured CPU and memory for a future batch, including its source VM. Zero means no harness limit; host capacity still applies.</p><div className="vm-fields"><label>Total vCPUs<input type="number" min="0" max="256" value={settings.budget.cpus} onChange={e => setSettings({ ...settings, budget: { ...settings.budget, cpus: Number(e.target.value) } })} /></label><label>Total memory (MiB)<input type="number" min="0" max="262144" value={settings.budget.memory} onChange={e => setSettings({ ...settings, budget: { ...settings.budget, memory: Number(e.target.value) } })} /></label></div></>}
        <div className="vm-actions">{target === 'defaults' ? <button className="primary" disabled={busy} onClick={() => void run(async () => { await request('/api/vms/settings', { ...settings, defaults: resources }); await load('defaults'); setMessage('Defaults saved for the next new game. Budget applies to the next fork.'); })}>Save defaults</button> : <><button disabled={busy || session.running || session.busy} onClick={() => void modify(true)}>Preview changes</button><button className="primary" disabled={busy || session.running || session.busy || !canApply} onClick={() => void modify(false)}>Apply live changes</button></>}</div>
        {target !== 'defaults' && (session.running || session.busy) && <p>Pause the session using the main playback control first.</p>}
        {plan && <div className="vm-plan"><strong>{plan.applied ? 'Runtime result' : 'Modification plan'}</strong>{!plan.changes.length && <p>No changes needed.</p>}{plan.changes.map(c => <p key={c.field}><b>{c.field}: {c.disposition}</b>{c.reason && <span>{c.reason}</span>}</p>)}{[...plan.conflicts, ...plan.warnings].map((w, i) => <p key={i}>{w.message}</p>)}{plan.resizeStatus.map(r => <p key={r.resource}>{r.resource}: {r.state} · requested {r.requested} · actual {r.actual} · enforced {r.enforced}</p>)}{plan.changes.some(c => c.disposition !== 'live') && <p>For changes requiring restart, save new-game defaults and use Restart game. Restarting this VM in place would lose its in-memory game state.</p>}</div>}
      </>}
      {busy && <p role="status">Loading…</p>}{message && <p role="status">{message}</p>}{error && <p role="alert" className="skill-error">{error}</p>}
    </dialog>
  </>;
}
