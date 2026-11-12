import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Alert, Badge, Button, CopyField, PageHeader, Select, useConfirm } from '../components/ui';
import { ago } from '../lib';

interface Status {
  build: { version: string; revision: string | null; mode: string; custom: boolean };
  channel: 'stable' | 'validated-main'; checkedAt?: number; error?: string; eligible: boolean; paired: boolean;
  target?: { version: string; revision: string; notes: string; url: string };
  job?: { id: string; state: string; error?: string; durations?: Record<string, number> };
}
const terminal = new Set(['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required']);
const states: Record<string, string> = { queued: 'Waiting for updater', preparing: 'Preparing release and rehearsing migrations', draining: 'Pausing operations and draining requests', snapshot: 'Saving a consistent data backup', starting: 'Starting and checking the new release', opening: 'Opening normal operation', succeeded: 'Upgrade complete', 'rolled-back': 'Previous release restored', failed: 'Preparation failed', cancelled: 'Upgrade cancelled', 'recovery-required': 'Owner recovery required' };

export function Updates() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<string>();
  const confirm = useConfirm();
  const load = async () => {
    try { setStatus(await api<Status>('/admin/updates')); setOffline(false); }
    catch { setOffline(true); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 3000); return () => clearInterval(timer); }, []);
  async function act(path: string, body?: unknown, method = 'POST') {
    setBusy(true); setError('');
    try { await api(`/admin/updates/${path}`, { method, body }); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  const active = !!status?.job && !terminal.has(status.job.state);
  return <>
    <PageHeader title="Updates" description="Check releases and manage this server’s upgrade." actions={<Button loading={busy} disabled={active || offline} onClick={() => act('check')}>Check now</Button>} />
    <div className="max-w-3xl space-y-6">
      {error && <Alert>{error}</Alert>}
      {offline && <Alert tone="amber">Connection interrupted. Waiting for Switchboard to reconnect. Provider requests are never replayed automatically.</Alert>}
      {!status ? <p role="status" className="text-sm text-zinc-500">Loading update status…</p> : <>
        <section aria-labelledby="running-title" className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="running-title" className="font-semibold">Running server</h2><Badge>{status.build.mode}</Badge></div>
          <p className="mt-3 text-xl font-semibold tabular-nums">{status.build.version}</p>
          <p className="mt-1 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{status.build.revision ?? 'Revision unavailable'}</p>
          {status.build.custom && <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Custom or unverified build. Automatic upgrades are disabled to preserve local changes.</p>}
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Last successful check: {status.checkedAt ? ago(status.checkedAt) : 'Never'}. Checks are cached daily.</p>
        </section>
        <section aria-labelledby="release-title" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="release-title" className="font-semibold">Available release</h2>
            <Select aria-label="Release channel" value={status.channel} disabled={busy || active || offline} onChange={async e => {
              const channel = e.target.value;
              if (channel === 'validated-main' && !await confirm({ title: 'Use validated main?', message: 'Main follows development commits after CI passes. Stable releases remain the recommended channel.', confirm: 'Use validated main' })) return;
              await act('channel', { channel }, 'PUT');
            }}><option value="stable">Stable releases</option><option value="validated-main">Validated main (optional)</option></Select>
          </div>
          {status.error && <Alert tone="amber">{status.error}</Alert>}
          {status.target ? <>
            <div className="flex flex-wrap items-center gap-3"><span className="text-lg font-semibold">{status.target.version}</span><a className="text-sm text-indigo-600 underline dark:text-indigo-400" href={status.target.url} target="_blank" rel="noreferrer">Release notes</a></div>
            <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{status.target.revision}</p>
            {status.target.notes && <details className="text-sm"><summary className="cursor-pointer font-medium">Read release notes</summary><p className="mt-3 whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400">{status.target.notes}</p></details>}
            {!status.eligible && !status.build.custom && <p className="text-sm text-zinc-600 dark:text-zinc-400">This release is not a newer compatible descendant of the running build.</p>}
          </> : !status.error && <p className="text-sm text-zinc-500 dark:text-zinc-400">Check now to verify a compatible release.</p>}
          {status.paired ? <Button variant="primary" disabled={!status.eligible || active || offline || status.job?.state === 'recovery-required'} loading={busy} onClick={async () => {
            if (await confirm({ title: `Upgrade to ${status.target?.version}?`, message: 'Preparation runs while this server stays available. Cutover pauses operations, disconnects streams and snapshots all persistent data before restarting. Backup time is part of the outage. Reconnect afterward; provider requests are never automatically replayed.', confirm: 'Prepare upgrade' })) await act('jobs');
          }}>Upgrade</Button> : <Alert tone="indigo">Set up and enroll the host updater to enable upgrades. <Link className="underline" to="/docs/guides/managed-upgrades">Setup and recovery guide</Link></Alert>}
        </section>
        {status.job && <section aria-labelledby="outcome-title" className="space-y-3 border-t border-zinc-200 pt-5 dark:border-zinc-800" aria-live="polite">
          <h2 id="outcome-title" className="font-semibold">{states[status.job.state] ?? status.job.state}</h2>
          {active && <p className="text-sm text-zinc-600 dark:text-zinc-400">Keep this page open to follow the result. The host updater continues independently if this connection closes.</p>}
          {status.job.error && <Alert tone="amber">{status.job.error} <Link to="/docs/guides/managed-upgrades" className="underline">Recovery guide</Link></Alert>}
          {status.job.durations && <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{Object.entries(status.job.durations).map(([key, ms]) => <div key={key}><dt className="capitalize text-zinc-500">{key}</dt><dd className="tabular-nums">{(ms / 1000).toFixed(1)} s</dd></div>)}</dl>}
          {['queued', 'preparing'].includes(status.job.state) && <Button disabled={busy || offline} onClick={() => act('jobs/cancel')}>Cancel before cutover</Button>}
        </section>}
        <section aria-labelledby="updater-title" className="space-y-3 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-3"><h2 id="updater-title" className="font-semibold">Host updater</h2><Badge tone={status.paired ? 'green' : 'neutral'}>{status.paired ? 'Connected' : 'Not connected'}</Badge></div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Enrollment grants upgrade control only. Codes expire after 10 minutes and can be used once. Keep the launcher and its recovery journal outside your application and data directories.</p>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || active || offline} onClick={async () => {
            setBusy(true); setError(''); try { const r = await api<{ code: string }>('/admin/updates/enrollment', { method: 'POST' }); setEnrollment(r.code); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>Create enrollment code</Button><Button disabled={busy || active || offline} onClick={async () => { if (await confirm({ title: 'Disconnect updater?', message: 'Its credential will stop working. Enroll again to restore managed upgrades.', confirm: 'Disconnect' })) { await act('enrollment', undefined, 'DELETE'); setEnrollment(undefined); } }}>Disconnect updater</Button></div>
          {enrollment && <div className="space-y-2"><p className="text-sm">Use this code with the launcher’s enroll command:</p><CopyField value={enrollment} /><Button onClick={() => setEnrollment(undefined)}>Hide code</Button></div>}
          <Link className="inline-block text-sm text-indigo-600 underline dark:text-indigo-400" to="/docs/guides/managed-upgrades">Setup, adoption and recovery</Link>
        </section>
      </>}
    </div>
  </>;
}
