import type { PlanView } from '../../contracts/src/session.ts';

export function PlanProgress({ plan, judging = false }: { plan?: PlanView; judging?: boolean }) {
  if (!plan) return null;
  const status = plan.status === 'running' ? `step ${plan.step + 1}/${plan.steps.length}` : plan.status === 'horizon' ? (judging ? 'judging' : 'trial complete') : plan.status === 'replan' ? (plan.reason === 'player died' ? 'ended' : 'needs new plan') : 'complete';
  return <div className="plan-status" title={`${plan.steps.map((step, i) => `${i + 1}. ${step}`).join(' → ')}${plan.reason ? ` · ${plan.reason}` : ''}`}>
    <span className="plan-step-count">{status}</span><span>{plan.status === 'running' ? plan.steps[plan.step] : plan.status === 'horizon' ? (judging ? 'comparing outcomes' : undefined) : plan.reason}</span>
    <div className="plan-step-track" aria-label={`${plan.label}: ${status}`}>{plan.steps.map((step, i) => <i key={i} title={step} className={plan.status === 'complete' || i < plan.step ? 'done' : i === plan.step ? 'current' : ''} />)}</div>
  </div>;
}
