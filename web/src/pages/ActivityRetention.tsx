import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Alert, Button, Dialog, FormField, Input, PageHeader, Spinner } from '../components/ui';

interface RetentionSettings {
  hours: number;
  revision: string;
  capture: { available: boolean; reason: 'ready' | 'restore-unsupported' | 'not-provisioned' | 'storage-unavailable' };
}
interface RetentionChange { hours: number; revision: string }
const availabilityMessages = {
  'restore-unsupported': 'This server’s installation needs an update before it can store output previews.',
  'not-provisioned': 'Output preview storage has not been set up on this server.',
  'storage-unavailable': 'Output preview storage is currently unavailable on this server.',
};

export function ActivityRetention() {
  const [effective, setEffective] = useState<RetentionSettings>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<RetentionChange | null>(null);
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (pending) { const frame = requestAnimationFrame(() => cancel.current?.focus()); return () => cancelAnimationFrame(frame); } }, [pending]);
  const load = async (signal?: AbortSignal) => {
    const result = await api<RetentionSettings>('/admin/activity-retention', { cache: 'no-store', signal });
    setEffective(result); return result;
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(result => setDraft(String(result.hours)), () => {
      if (!controller.signal.aborted) setError('Couldn’t load activity retention.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const hours = Number(draft);
  const valid = /^\d+$/.test(draft) && Number.isSafeInteger(hours);
  const persist = async (change: RetentionChange) => {
    // Guard writes as well as form submits, including repeated events before React renders.
    if (!effective || loading || busy.current || saving || change.revision !== effective.revision) return;
    busy.current = true;
    setPending(null); setSaving(true); setMessage('Saving output preview retention…'); setError('');
    try {
      const result = await api<RetentionSettings>('/admin/activity-retention', { method: 'PUT', body: change });
      setEffective(result); setDraft(String(result.hours)); setMessage('Output preview retention saved.');
    } catch (e) {
      // Reload after conflict or a lost response; preserve the draft and require another explicit save.
      try {
        await load();
        setError(e instanceof ApiError && e.status === 409
          ? 'Another administrator changed retention. The current setting has been reloaded. Review your draft and save again.'
          : 'Couldn’t confirm the save. The current setting has been reloaded; review your draft before saving again.');
      } catch {
        setEffective(undefined);
        setError('Couldn’t save or reload activity retention. Retry loading the current setting.');
      }
      setMessage('');
    } finally {
      busy.current = false; setSaving(false);
      requestAnimationFrame(() => (save.current ?? input.current)?.focus());
    }
  };
  const dismiss = () => { setPending(null); requestAnimationFrame(() => save.current?.focus()); };
  const reload = async () => {
    if (loading || busy.current || saving) return;
    setLoading(true); setError('');
    try {
      const result = await load();
      setDraft(previous => previous || String(result.hours));
    } catch { setEffective(undefined); setError('Couldn’t load activity retention.'); }
    finally { setLoading(false); }
  };
  return <>
    <PageHeader title="Activity retention" />
    <form className="max-w-lg space-y-5" onSubmit={e => {
      e.preventDefault();
      if (loading || busy.current || saving || pending) return;
      if (!effective) { setError('Load the current retention setting before saving.'); return; }
      setMessage('');
      if (!valid) { setInvalid(true); input.current?.focus(); return; }
      setInvalid(false);
      const change = { hours, revision: effective.revision };
      if (hours === 0 || hours < effective.hours) setPending(change); else void persist(change);
    }}>
      <FormField htmlFor="output-hours" label="Output preview retention">
        <div className="flex items-center gap-3">
          <Input ref={input} id="output-hours" inputMode="numeric" value={draft} disabled={loading || saving || !!pending} onChange={e => { setDraft(e.target.value); setInvalid(false); }} aria-invalid={invalid} aria-describedby="output-hours-unit output-hours-help output-hours-error" className="max-w-40" />
          <span id="output-hours-unit">hours</span>
        </div>
      </FormField>
      <div id="output-hours-help" className="space-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
        <p>Default: 4 hours. Enter 0 to stop storing previews.</p>
        <p>This setting applies to output previews. Request entries keep their own retention.</p>
        {effective && <p>Current setting: {effective.hours} hours.</p>}
        {effective && hours > effective.hours && <p>The new duration applies to future previews. Existing deadlines stay as saved.</p>}
      </div>
      {effective && !effective.capture.available && <Alert tone="amber">
        {availabilityMessages[effective.capture.reason as keyof typeof availabilityMessages]}
        {' '}The retention setting can be saved, but this server is not capturing previews.
      </Alert>}
      <p id="output-hours-error" role={invalid ? 'alert' : undefined} className="text-[13px] text-red-600 dark:text-red-400">{invalid ? 'Enter a whole number of hours, 0 or greater.' : ''}</p>
      {error && <Alert>{error}</Alert>}
      {!effective ? <Button type="button" disabled={loading || saving} onClick={() => void reload()}>{loading ? 'Loading setting…' : 'Reload setting'}</Button>
        : <Button ref={save} type="submit" variant="primary" disabled={loading || saving || !!pending}>{saving && <Spinner className="size-4" />}Save changes</Button>}
      <p role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{message}</p>
    </form>
    <Dialog open={!!pending} onClose={dismiss} title={pending?.hours === 0 ? 'Disable output previews' : 'Shorten retention'} size="sm" footer={<>
      <Button ref={cancel} autoFocus onClick={dismiss}>Cancel</Button>
      <Button disabled={saving} style={{ whiteSpace: 'normal', height: 'auto', minHeight: 36 }} variant={pending?.hours === 0 ? 'danger' : 'primary'} onClick={() => { if (pending) void persist(pending); }}>{pending?.hours === 0 ? 'Disable output previews' : 'Shorten retention'}</Button>
    </>}>
      <p className="text-[13px] leading-relaxed">{pending?.hours === 0 ? 'Switchboard will stop storing previews and clear all currently stored previews. Request entries keep their own retention.' : `Existing previews will expire ${pending?.hours} ${pending?.hours === 1 ? 'hour' : 'hours'} after they were captured, or earlier if they already had an earlier deadline. Previews already that old will become unavailable immediately.`}</p>
    </Dialog>
  </>;
}
