import { useState } from 'react';
import type { WorldView } from '../../contracts/src/session.ts';

export function StrategyPanel({ world }: { world: WorldView }) {
  const [open, setOpen] = useState(() => localStorage.getItem('mom-strategy-expanded') === 'true');
  const menu = world.decisionOptions;
  const changes = menu?.changes;
  return <details className="strategy-panel" open={open} onToggle={event => {
    const value = event.currentTarget.open; setOpen(value); localStorage.setItem('mom-strategy-expanded', String(value));
  }}>
    <summary><span>{menu?.kind === 'actions' ? 'Available actions' : 'Available plans'}</span><small>{menu ? `${menu.options.length} ${menu.kind === 'plans' ? 'plans' : 'actions'}` : 'awaiting a decision'}</small></summary>
    {open && <div className="strategy-body">
      {world.temporaryGoal && <section aria-label="Temporary goal">
        <div className="strategy-heading"><h3>Temporary goal</h3><small>{world.temporaryGoal.record.status}</small></div>
        <p>{world.temporaryGoal.record.draft.instruction}</p>
        <p className="strategy-context">{world.temporaryGoal.record.status === 'active'
          ? `${Math.max(0, (world.temporaryGoal.record.expiresAt - world.state.tick) / 35).toFixed(1)}s remaining · supports your main objective`
          : world.temporaryGoal.record.outcome}</p>
        <details><summary>Why this goal</summary><p>{world.temporaryGoal.record.draft.reason}</p></details>
      </section>}
      <section aria-label="Available decision options"><div className="strategy-heading"><h3>{world.role === 'main' ? 'Main session' : 'Focused future'}</h3><small>generation {world.generation}</small></div>
        {menu ? <><p className="strategy-context">From this world’s latest decision · {(menu.tick / 35).toFixed(1)}s game time{world.thinking ? ' · reassessing…' : ''}</p><ul className="strategy-options">{menu.options.map(option => <li key={option.id} className={option.id === menu.selected ? 'chosen' : ''}><details><summary><span>{option.label}</span>{option.id === menu.selected && <small>chosen</small>}</summary>{option.steps && <ol>{option.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}{option.evidence && <p>{option.evidence}</p>}</details></li>)}</ul></> : <p>Options will appear when Jev next makes a decision in this world.</p>}
        {changes && <details className="strategy-changes"><summary>Latest option changes · {(changes.tick / 35).toFixed(1)}s</summary>{changes.added.length > 0 && <p><strong>Added</strong> {changes.added.join(', ')}</p>}{changes.removed.length > 0 && <p><strong>Removed</strong> {changes.removed.join(', ')}</p>}{changes.updated.length > 0 && <p><strong>Updated</strong> {changes.updated.join(', ')}</p>}</details>}
      </section>
    </div>}
  </details>;
}
