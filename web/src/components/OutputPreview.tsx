import { acceptDisplayGrant, displayGrantActive, type DisplayClock } from './output-display-grant';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Button, Spinner } from './ui';

export interface OutputMetadata { state: string; captureId?: string; expiresAt?: number }
interface OutputReply extends OutputMetadata { preview?: unknown; decisionAt: number; displayForMs?: number }

const explanations: Record<string, string> = {
  legacy: 'This request was logged before output previews were available.',
  omitted: 'No output preview was saved for this request.',
  disabled: 'Output preview storage was disabled when this request ran.',
  expired: 'This output preview has expired.',
  unavailable: 'This output preview is unavailable.',
  failed: 'Couldn’t load the output preview.',
};

export function OutputPreview({ id, metadata }: { id: number; metadata: OutputMetadata }) {
  const panel = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState(metadata.state);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<OutputReply>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    let capture: string | undefined;
    let grant: DisplayClock | undefined;
    const clock = () => ({ monotonic: performance.now(), wall: Date.now() });
    let deadline: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const clear = (next: string) => {
      if (!live) return;
      live = false;
      controller.abort();
      clearTimeout(deadline);
      const restoreFocus = document.activeElement === retry.current || document.activeElement === button.current;
      setData(undefined); setLoading(false); setState(next); setExpanded(false);
      if (restoreFocus) requestAnimationFrame(() => (button.current ?? heading.current)?.focus());
    };
    const read = async (payload: boolean) => {
      if (!payload && (!grant || !displayGrantActive(grant, clock()))) return clear('failed');
      const sent = clock();
      try {
        const result = await api<OutputReply>(`/audit/${id}/output${payload ? '' : '/status'}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), cache: 'no-store',
        });
        if (!live) return;
        if (document.hidden || !navigator.onLine) return clear('failed');
        if (result.state !== 'retained') return clear(result.state);
        if (!result.captureId || (capture && capture !== result.captureId)) return clear('unavailable');
        const next = acceptDisplayGrant(payload ? undefined : grant, sent, result.displayForMs ?? 0, clock());
        if (!next) return clear('failed');
        grant = next;
        capture = result.captureId;
        clearTimeout(deadline);
        deadline = setTimeout(() => clear(result.expiresAt && result.expiresAt <= Date.now() ? 'expired' : 'failed'), Math.max(0, grant.monotonic - performance.now()));
        if (payload) { setData(result); setLoading(false); }
        else setData(previous => previous ? { ...previous, expiresAt: result.expiresAt } : previous);
      } catch (e) {
        if (live) clear(e instanceof ApiError && [401, 403, 404].includes(e.status) ? 'unavailable' : 'failed');
      }
    };
    setData(undefined); setLoading(true);
    void read(true);
    const poll = setInterval(() => { if (capture) void read(false); }, 5000);
    const hide = () => clear('retained');
    const visibility = () => { if (document.hidden) hide(); };
    const offline = () => clear('failed');
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', hide);
    window.addEventListener('offline', offline);
    // Check before paint on resume, even when timers were suspended.
    let frame = 0;
    const check = () => {
      if (capture && (grant && !displayGrantActive(grant, clock()))) clear('failed');
      if (live) frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => {
      live = false; controller.abort(); clearInterval(poll); clearTimeout(deadline); cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', hide); window.removeEventListener('offline', offline);
    };
  }, [id, expanded, attempt]);
  const reveal = () => { const fromRetry = document.activeElement === retry.current; if (fromRetry) requestAnimationFrame(() => button.current?.focus()); setState('retained'); setExpanded(true); setAttempt(n => n + 1); };
  const hide = () => { setExpanded(false); setData(undefined); setLoading(false); };
  const eligible = state === 'retained' || state === 'captured';
  return (
    <section className="min-w-0 space-y-2" aria-labelledby={panel + '-heading'}>
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 ref={heading} id={panel + '-heading'} tabIndex={-1} className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Output preview</h3>
        {(eligible || expanded) && <Button ref={button} size="sm" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-400" aria-expanded={expanded} aria-controls={panel} onClick={expanded ? hide : reveal}>{expanded ? 'Hide output' : 'View output'}</Button>}
      </div>
      <div role="status" aria-live="polite" className={data ? 'sr-only' : 'text-xs text-zinc-500 dark:text-zinc-400'}>
        {loading ? <span className="inline-flex items-center gap-2"><Spinner className="size-3" />Loading output preview…</span> : data ? 'Output preview loaded.' : explanations[state] ?? 'Previews are available for selected operations.'}
      </div>
      {state === 'failed' && <Button ref={retry} size="sm" onClick={reveal}>Retry</Button>}
      <div id={panel} hidden={!expanded}>
        {data && <div className="space-y-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Redacted JSON · Only selected fields are shown.</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Available until {new Date(data.expiresAt!).toLocaleString(undefined, { ...(new Date(data.expiresAt!).toDateString() !== new Date().toDateString() ? { dateStyle: 'medium' as const } : {}), timeStyle: 'short' })}</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-zinc-50 p-3 font-mono text-[12.5px] text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">{JSON.stringify(data.preview, null, 2)}</pre>
        </div>}
      </div>
    </section>
  );
}
