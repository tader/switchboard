import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Alert, Button, Dialog, FormField, Input, PageHeader, Spinner } from '../components/ui';

export function ActivityRetention() {
  const [effective, setEffective] = useState<number>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) { const frame = requestAnimationFrame(() => cancel.current?.focus()); return () => cancelAnimationFrame(frame); } }, [confirm]);
  const load = async () => {
    const result = await api<{ hours: number }>('/admin/activity-retention', { cache: 'no-store' });
    setEffective(result.hours); return result.hours;
  };
  useEffect(() => { void load().then(n => setDraft(String(n)), () => setError('Couldn’t load activity retention.')); }, []);
  const hours = Number(draft);
  const valid = /^\d+$/.test(draft) && Number.isSafeInteger(hours);
  const persist = async () => {
    setConfirm(false); setSaving(true); setMessage('Saving output preview retention…'); setError('');
    try {
      const result = await api<{ hours: number }>('/admin/activity-retention', { method: 'PUT', body: { hours } });
      setEffective(result.hours); setDraft(String(result.hours)); setMessage('Output preview retention saved.');
    } catch {
      // Resolve a lost response before offering another consequential write.
      try { await load(); setError('Couldn’t confirm the save. The effective setting has been reloaded; review your draft before saving again.'); }
      catch { setEffective(undefined); setError('Couldn’t save or reload activity retention. Retry loading the effective setting.'); }
      setMessage('');
    } finally { setSaving(false); requestAnimationFrame(() => save.current?.focus()); }
  };
  return <>
    <PageHeader title="Activity retention" />
    <form className="max-w-lg space-y-5" onSubmit={e => {
      e.preventDefault(); setMessage('');
      if (!valid) { setInvalid(true); input.current?.focus(); return; }
      setInvalid(false);
      if (hours === 0 || hours < effective!) setConfirm(true); else void persist();
    }}>
      <FormField htmlFor="output-hours" label="Output preview retention">
        <div className="flex items-center gap-3">
          <Input ref={input} id="output-hours" inputMode="numeric" value={draft} onChange={e => { setDraft(e.target.value); setInvalid(false); }} aria-invalid={invalid} aria-describedby="output-hours-unit output-hours-help output-hours-error" className="max-w-40" />
          <span id="output-hours-unit">hours</span>
        </div>
      </FormField>
      <div id="output-hours-help" className="space-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
        <p>Default: 4 hours. Enter 0 to stop storing previews.</p>
        <p>This setting applies to output previews. Request entries keep their own retention.</p>
        {effective !== undefined && <p>Current setting: {effective} hours.</p>}
        {effective !== undefined && hours > effective && <p>The new duration applies to future previews. Existing deadlines stay as saved.</p>}
      </div>
      <p id="output-hours-error" role={invalid ? 'alert' : undefined} className="text-[13px] text-red-600 dark:text-red-400">{invalid ? 'Enter a whole number of hours, 0 or greater.' : ''}</p>
      {error && <Alert>{error}</Alert>}
      {effective === undefined ? <Button type="button" onClick={() => { setError(''); void load().then(n => setDraft(String(n)), () => setError('Couldn’t load activity retention.')); }}>Reload setting</Button> : <Button ref={save} type="submit" variant="primary" disabled={saving || confirm}>{saving && <Spinner className="size-4" />}Save changes</Button>}
      <p role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{message}</p>
    </form>
    <Dialog open={confirm} onClose={() => { setConfirm(false); requestAnimationFrame(() => save.current?.focus()); }} title={hours === 0 ? 'Disable output previews' : 'Shorten retention'} size="sm" footer={<>
      <Button ref={cancel} autoFocus onClick={() => { setConfirm(false); requestAnimationFrame(() => save.current?.focus()); }}>Cancel</Button>
      <Button style={{ whiteSpace: 'normal', height: 'auto', minHeight: 36 }} variant={hours === 0 ? 'danger' : 'primary'} onClick={() => void persist()}>{hours === 0 ? 'Disable output previews' : 'Shorten retention'}</Button>
    </>}>
      <p className="text-[13px] leading-relaxed">{hours === 0 ? 'Switchboard will stop storing previews and clear all currently stored previews. Request entries keep their own retention.' : `Existing previews will expire ${hours} ${hours === 1 ? 'hour' : 'hours'} after they were captured, or earlier if they already had an earlier deadline. Previews already that old will become unavailable immediately.`}</p>
    </Dialog>
  </>;
}
