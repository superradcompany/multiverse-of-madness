import { useRef, useState } from 'react';
import { BookOpen, Plus, Pencil, Trash2, X, Upload } from 'lucide-react';
import { ACTIVE_SKILL_BUDGET, SKILL_TEXT_LIMIT, skillSize, type AiSkill } from '../../../packages/contracts/src/skills.ts';
import type { SessionView } from '../../../packages/contracts/src/session.ts';

const blank = { name: '', instructions: '', enabled: true };
export function SkillsPanel({ session, command }: { session: SessionView; command: (body: object, onError?: (message: string) => void) => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Omit<AiSkill, 'id'> & { id?: string }>(blank);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const skills = session.skills ?? [], enabled = skills.filter(s => s.enabled).length;
  const run = async (body: object) => {
    setBusy(true); setError('');
    try { return await command(body, setError); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="icon skills-trigger" aria-label={`AI skills · ${enabled} enabled`} title={`AI skills · ${enabled} enabled`} aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}><BookOpen />{enabled > 0 && <span className="skills-count" aria-hidden="true">{enabled}</span>}</button>
    <dialog ref={dialog} className="skills-dialog" aria-labelledby="skills-heading">
      <div className="skills-heading"><h2 id="skills-heading">AI skills</h2><button type="button" className="icon" aria-label="Close AI skills" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <p>Reusable instructions for every Jev decision, across all worlds. Your current guide takes priority.</p>
      <div className="skills-budget">{skillSize(skills)} / {ACTIVE_SKILL_BUDGET} characters enabled · {skills.length} / 32 saved</div>
      <div className="skills-list">{!skills.length && <p>No skills yet. Add a tactic such as finding an escape route before engaging an enemy.</p>}{skills.map(skill => <div className="skill-row" key={skill.id}>
        <label><input type="checkbox" checked={skill.enabled} disabled={busy} onChange={e => void run({ type: 'skill-toggle', id: skill.id, enabled: e.target.checked })} /><span>{skill.name}</span></label>
        <button type="button" className="icon" aria-label={`Edit ${skill.name}`} disabled={busy} onClick={() => { setDraft({ ...skill }); setEditing(true); setError(''); }}><Pencil size={16} /></button>
        <button type="button" className="icon" aria-label={`Delete ${skill.name}`} disabled={busy} onClick={() => void run({ type: 'skill-delete', id: skill.id }).then(ok => { if (ok && draft.id === skill.id) setEditing(false); })}><Trash2 size={16} /></button>
      </div>)}</div>
      {!editing && <button type="button" className="skills-add" disabled={busy || skills.length >= 32} onClick={() => { setDraft({ ...blank }); setEditing(true); setError(''); }}><Plus size={16} /> Add skill</button>}
      {editing && <form className="skill-editor" onSubmit={e => { e.preventDefault(); e.stopPropagation(); void run({ type: 'skill-save', ...draft }).then(ok => { if (ok) { setEditing(false); setDraft({ ...blank }); } }); }}>
        <label>Name<input required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. tactical retreat" /></label>
        <label>Instructions<textarea required rows={7} maxLength={SKILL_TEXT_LIMIT} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })} placeholder="When health is low, break line of sight and move toward reachable health. Avoid repeating an approach that already failed." /></label>
        <div className="skill-import"><label><Upload size={14} /> Import Markdown<input type="file" accept=".md,.txt,text/plain,text/markdown" onChange={e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          if (file.size > 16000) { setError('Choose a short Markdown skill (at most 16 KB).'); return; }
          void file.text().then(text => {
            if (!text.trim() || text.length > SKILL_TEXT_LIMIT) { setError(`Instructions must contain 1–${SKILL_TEXT_LIMIT} characters. Shorten the file before importing.`); return; }
            setDraft(old => ({ ...old, name: old.name || file.name.replace(/\.(md|txt)$/i, '').slice(0, 60), instructions: text })); setError('');
          }).catch(() => setError('Could not read that file.'));
        }} /></label><span>{draft.instructions.length} / {SKILL_TEXT_LIMIT}</span></div>
        <label className="skill-enable"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> Enable at the next decision</label>
        <div className="skill-actions"><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy || !draft.name.trim() || !draft.instructions.trim()}>{busy ? 'Saving…' : 'Save skill'}</button></div>
      </form>}
      {error && <p role="alert" className="skill-error">{error}</p>}
      <p className="skill-footnote">Skills survive game restarts. Markdown is sent as instructions; scripts and linked files are not executed or loaded.</p>
    </dialog>
  </>;
}
