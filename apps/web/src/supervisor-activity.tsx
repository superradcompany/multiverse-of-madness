import { useEffect, useState } from 'react';
import type { LearningView } from '../../../packages/contracts/src/learning.ts';
import { LearningEvaluation } from './learning-evaluation.tsx';
import { learningResult, reviewReason, visibleSupervisorProposal } from './supervisor-presentation.ts';
import type { SessionView } from '../../../packages/contracts/src/session.ts';

/** A spectator view of automatic work, never a manual experiment workflow. */
export function SupervisorActivity({ session }: { session: SessionView }) {
  const [data, setData] = useState<LearningView>(), [error, setError] = useState('');
  const [selected, setSelected] = useState('latest');
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/learning', { signal: abort.signal });
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Could not read supervisor activity');
        if (!abort.signal.aborted) { setData(value); setError(''); }
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const applied = data?.proposals.find(item => item.revision.id === data.active?.revision.id && item.revision.version === data.active?.revision.version);
  const proposal = visibleSupervisorProposal(data, selected);
  const job = data?.jobs.find(item => ['queued', 'running', 'cancelling'].includes(item.status));
  const planner = proposal?.changes.some(change => change.field === 'executor' || change.field === 'model' && (change.after as { id?: string })?.id === 'prepared-doom-jev');
  const comparison = proposal && data?.jobs.some(item => item.kind === 'evaluate' && item.proposalId === proposal.id);
  const currentReview = selected === 'latest' && data?.automation?.cycle;
  const drafting = currentReview && job?.kind === 'propose';
  const inUse = Boolean(proposal && proposal.id === applied?.id);
  const changeKinds = proposal?.changes.map(change => ({ executor: 'the available gameplay plans', model: 'how Jev makes decisions',
    prompts: 'the AI instructions', skills: 'the AI skills', policy: 'the gameplay settings' }[change.field] ?? 'the gameplay strategy'));
  const heading = !data ? 'Loading supervisor activity…' : !data.automation?.enabled ? 'Automatic learning is paused'
    : job?.preparingCheckpoint ? 'Preparing a gameplay checkpoint' : job?.kind === 'propose' ? 'Looking for a better approach' : job?.kind === 'evaluate' ? 'Testing an improvement'
    : 'Watching for recurring problems';
  return <div className="supervisor-activity">
    <div className="supervisor-activity-heading"><strong>Gameplay improvements</strong></div>
    <h2>{heading}</h2>
    <p>Jev plays the game. The supervisor looks for recurring problems, tries changes in separate games, and applies changes that pass its tests. You don’t need to start anything here.</p>
    {session.planningMode === 'actions' && <p className="supervisor-mode-note">You’re using single actions. Switch to short plans in playback settings to use plans created by the supervisor.</p>}
    {selected !== 'latest' && <p className="supervisor-history-notice">Viewing an earlier attempt. <button onClick={() => setSelected('latest')}>Back to current activity</button></p>}
    {(currentReview || proposal) && <div className="supervisor-story">
      <section><h3>What it noticed</h3><p>{currentReview ? reviewReason(currentReview.reason) : 'This earlier attempt was based on gameplay observed at the time. Its full reasoning is available below.'}</p></section>
      <section><h3>What it’s trying</h3><p>{job?.preparingCheckpoint && currentReview ? 'Waiting for a safe point to save the game before requesting a review. The AI review has not started. If futures are paused, continue or choose a winner to finish that comparison.' : drafting || !proposal ? 'Reviewing what happened and preparing a possible change. No new change has been applied.'
        : `An adjustment to ${[...new Set(changeKinds)].join(', ')}.`}</p>
        {proposal && <details><summary>Read the proposed change</summary><p>{proposal.reason}</p></details>}
      </section>
      <section><h3>{inUse ? 'Now in use' : 'Did it help?'}</h3><p>{inUse ? 'This change passed the comparison and is now guiding gameplay.'
        : proposal?.error ? 'This attempt could not finish. The existing strategy stays in use.'
        : proposal?.result ? proposal.result.accepted ? 'It passed the comparison. Passing a test does not mean it is already in use.' : learningResult(proposal.result.reason)
        : comparison ? 'Still testing. The current strategy stays in use until the comparison is finished.'
        : 'Not tested yet. The current strategy stays in use.'}</p></section>
    </div>}
    {!currentReview && !proposal && <p>No new changes to review yet. Improvements will appear here as the supervisor works.</p>}
    {comparison && proposal && <details className="supervisor-test-details"><summary>See the comparison games</summary><p>These are separate test games, not your main session. Previews show saved frames rather than a continuous live video.</p><LearningEvaluation key={proposal.id} proposalId={proposal.id} /></details>}
    {data && data.proposals.length > 0 && <details className="supervisor-past"><summary>Past attempts · {data.proposals.length}</summary><label className="supervisor-history">Show attempt<select aria-label="Supervisor change to inspect" value={selected} onChange={event => setSelected(event.target.value)}><option value="latest">Current activity</option>{data.proposals.map((item, index) => <option key={item.id} value={item.id}>Attempt {data.proposals.length - index} · {item.id === applied?.id ? 'in use' : item.result?.accepted ? 'passed tests' : item.result ? 'not applied' : item.status}</option>)}</select></label></details>}
    <details className="supervisor-technical"><summary>Technical details</summary><p>Active revision: {data?.active?.epoch ?? 'loading'}. {planner ? 'This attempt changes the planner implementation.' : ''}</p>{proposal?.result && <p>{proposal.result.reason}{proposal.result.meanGain !== undefined ? ` · mean test score change ${proposal.result.meanGain.toFixed(1)}` : ''}</p>}{proposal?.error && <p className="skill-error">{proposal.error}</p>}{currentReview && <p>Review trigger: {currentReview.reason}</p>}</details>
    {(error || data?.automation?.error || job?.error) && <p role="alert" className="skill-error">{error || data?.automation?.error || job?.error}</p>}
  </div>;
}
