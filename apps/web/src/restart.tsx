import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

export function RestartGame({ restart }: { restart: () => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  return <>
    <button className="icon" title="Restart game" aria-label="Restart game" onClick={() => setOpen(true)}><RotateCcw /></button>
    <dialog className="restart-dialog" ref={dialog} aria-labelledby="restart-title" onCancel={e => { if (busy) e.preventDefault(); else setOpen(false); }}>
      <h2 id="restart-title">Start a new game?</h2>
      <p>This ends the current game and all its futures. It permanently clears this run’s retained replays, alternative recordings, and learned attempts.</p>
      <p>Your objective, downloaded game assets, and credentials are kept.</p>
      <div><button autoFocus disabled={busy} onClick={() => setOpen(false)}>cancel</button><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { if (await restart()) setOpen(false); } finally { setBusy(false); } }}>{busy ? 'restarting…' : 'clear run & restart'}</button></div>
    </dialog>
  </>;
}
