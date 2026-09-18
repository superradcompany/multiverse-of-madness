import { SupervisorActivity } from './supervisor-activity.tsx';
import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import type { BackgroundLearningView, SupervisorCli } from '../../../packages/contracts/src/learning.ts';
import type { SessionView } from '../../../packages/contracts/src/session.ts';

async function request(body?: unknown, signal?: AbortSignal): Promise<BackgroundLearningView> {
  const response = await fetch(body ? '/api/learning' : '/api/learning/status', { signal, ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Learning request failed');
  return body ? request(undefined, signal) : result;
}

/** One poller shared by the quiet status indicator and gameplay settings. */
export function useBackgroundLearning() {
  const [data, setData] = useState<BackgroundLearningView>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const serial = useRef(0), mounted = useRef(false), changing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const id = ++serial.current;
      try {
        if (!changing.current) {
          const value = await request(undefined, controller.signal);
          if (mounted.current && id === serial.current) { setData(value); setError(''); }
        }
      } catch (e) {
        if (!controller.signal.aborted && mounted.current && id === serial.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); serial.current++; };
  }, []);
  const configure = async (enabled: boolean, provider: SupervisorCli) => {
    if (changing.current) return;
    changing.current = true; serial.current++; setSending(true); setError('');
    try {
      const value = await request({ type: 'automation', enabled, provider });
      serial.current++;
      if (mounted.current) setData(value);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      changing.current = false;
      if (mounted.current) setSending(false);
    }
  };
  return { data, error, sending, configure };
}
type BackgroundLearning = ReturnType<typeof useBackgroundLearning>;
function status({ data, error }: BackgroundLearning) {
  if (error || data?.error) return 'Supervisor needs attention';
  if (!data) return 'Connecting to supervisor';
  return {
    waiting: 'Supervisor waiting for a safe gameplay checkpoint', unavailable: 'Supervisor unavailable',
    paused: 'Supervisor paused', watching: 'Supervisor watching gameplay', reviewing: 'Supervisor reviewing gameplay',
    testing: 'Supervisor testing improvement', applying: 'Supervisor applying improvement',
  }[data.stage];
}
export function LearningStatus({ learning, session }: { learning: BackgroundLearning; session: SessionView }) {
  const [open, setOpen] = useState(false);
  const label = status(learning);
  const issue = Boolean(learning.error || learning.data?.error);
  return <details className="supervisor-control" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={'icon supervisor-status' + (issue ? ' has-error' : '')} title={`${label}. View automatic learning.`} aria-label={`${label}. View automatic learning`}>
      <Brain size={19} aria-hidden="true" />
    </summary>
    {open && <SupervisorActivity session={session} />}
  </details>;
}
export function LearningSettings({ learning }: { learning: BackgroundLearning }) {
  const { data, error, sending, configure } = learning;
  return <section className="supervisor-settings" aria-label="Background self-learning">
    <label><input type="checkbox" checked={data?.enabled ?? false} disabled={sending || !data?.ready}
      onChange={event => void configure(event.target.checked, data?.provider ?? 'codex')} /> background self-learning</label>
    <p>{status(learning)}. Jev plays each turn; the supervisor reviews persistent problems and tests improvements automatically.</p>
    <label htmlFor="background-supervisor">supervisor</label>
    <select id="background-supervisor" value={data?.provider ?? 'codex'} disabled={sending || !data?.ready}
      onChange={event => void configure(data?.enabled ?? false, event.target.value as SupervisorCli)}>
      <option value="codex">Codex CLI</option><option value="claude">Claude CLI</option>
    </select>
    {(error || data?.error) && <p role="alert" className="skill-error">{error || data?.error}</p>}
  </section>;
}
