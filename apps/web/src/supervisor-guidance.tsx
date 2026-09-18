import { ChevronDown } from 'lucide-react';
import type { BackgroundLearningView } from '../../../packages/contracts/src/learning.ts';

/** Displays only activated guidance; proposed changes remain explicitly pending. */
export function SupervisorGuidance({ learning }: { learning?: BackgroundLearningView }) {
  const strategy = learning?.strategy;
  return <div className="supervisor-guidance-body">
    <p className="guidance-priority">Your goal takes priority. The supervisor adjusts how Jev pursues it.</p>
      <section className="supervisor-guidance" aria-label="Active supervisor guidance"><details className="strategy-guidance"><summary className="strategy-heading"><span>Supervisor guidance</span>{strategy && <small>active · revision {strategy.activation.epoch}</small>}<ChevronDown size={13} /></summary>
        {!strategy ? <p>Connecting to the supervisor…</p> : strategy.guidance.length ? strategy.guidance.map(item => <div className="strategy-guide" key={item.slot}><span>{item.slot === 'guide' ? 'Working strategy' : `${item.slot} guidance`}</span><p>{item.text}</p></div>) : <p>No additional learned guidance. Jev follows your goal and enabled skills.</p>}
        {strategy?.skills.map(skill => <details className="strategy-skill" key={skill.id}><summary>{skill.id}</summary><p>{skill.instructions}</p></details>)}
        {strategy?.previousGuidance && JSON.stringify(strategy.previousGuidance) !== JSON.stringify(strategy.guidance) && <details className="strategy-rationale"><summary>Previous guidance</summary>{strategy.previousGuidance.length ? strategy.previousGuidance.map(item => <p key={item.slot}><strong>{item.slot}</strong> · {item.text}</p>) : <p>No additional learned guidance before this change.</p>}</details>}
        {strategy?.reason && <details className="strategy-rationale"><summary>Why the strategy changed</summary><p>{strategy.reason}</p></details>}
      </details></section>
      {learning && ['reviewing', 'testing', 'applying'].includes(learning.stage) && <p className="strategy-pending">{learning.stage === 'reviewing' ? 'Supervisor reviewing a possible change' : learning.stage === 'testing' ? 'Testing a proposed change' : 'A tested change is waiting to apply'}. The guidance above is currently active.</p>}
  </div>;
}
