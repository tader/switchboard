import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpCircle, BookOpen, CheckCircle2, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Alert, Badge, Button, CopyField, PageHeader, Select, useConfirm } from '../components/ui';
import { ago, cx } from '../lib';

interface Status {
  build: { version: string; revision: string | null; mode: string; custom: boolean };
  channel: 'stable' | 'validated-main'; checkedAt?: number; error?: string; eligible: boolean; paired: boolean;
  target?: { version: string; revision: string; notes: string; url: string };
  job?: { id: string; state: string; error?: string; durations?: Record<string, number> };
}
const terminal = new Set(['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required']);
const states: Record<string, string> = { queued: 'Waiting for updater', preparing: 'Preparing release', draining: 'Finishing active requests', snapshot: 'Backing up server data', starting: 'Starting the new release', opening: 'Resuming service', succeeded: 'Server updated', 'rolled-back': 'Previous release restored', failed: 'Update preparation failed', cancelled: 'Update cancelled', 'recovery-required': 'Recovery required' };
const phases = [
  { label: 'Prepare', states: ['queued', 'preparing'] },
  { label: 'Back up', states: ['draining', 'snapshot'] },
  { label: 'Restart', states: ['starting', 'opening'] },
];
const modes: Record<string, string> = { checkout: 'Git checkout', compose: 'Docker Compose', runtime: 'macOS app', custom: 'Custom installation' };
const link = 'font-medium text-indigo-600 underline underline-offset-4 decoration-indigo-300 hover:decoration-indigo-600 dark:text-indigo-400 dark:decoration-indigo-500/50';

export function Updates() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState<string>();
  const busy = !!pending;
  const [enrollment, setEnrollment] = useState<{ code: string; expiresAt: number }>();
  const [expired, setExpired] = useState(false);
  const confirm = useConfirm();
  const load = async () => {
    try { setStatus(await api<Status>('/admin/updates')); setOffline(false); }
    catch { setOffline(true); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 3000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (status?.paired) { setEnrollment(undefined); setExpired(false); } }, [status?.paired]);
  useEffect(() => {
    if (!enrollment) return;
    const timer = setTimeout(() => { setEnrollment(undefined); setExpired(true); }, Math.max(0, enrollment.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [enrollment]);
  async function act(path: string, body?: unknown, method = 'POST') {
    setPending(method === 'DELETE' ? 'disconnect' : path); setError('');
    try { await api(`/admin/updates/${path}`, { method, body }); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setPending(undefined); }
  }
  async function enroll() {
    setPending('enrollment'); setError(''); setExpired(false);
    try { setEnrollment(await api<{ code: string; expiresAt: number }>('/admin/updates/enrollment', { method: 'POST' })); }
    catch (e: any) { setError(e.message); }
    finally { setPending(undefined); }
  }
  const active = !!status?.job && !terminal.has(status.job.state);
  const recovery = status?.job?.state === 'recovery-required';
  const current = !!status?.target && status.target.revision === status.build.revision && !status.error;
  const title = active ? 'Updating your server' : recovery ? 'Recovery required' : status?.build.custom ? 'Managed updates unavailable' : status?.error ? 'Update check unavailable' : status?.eligible ? 'A server update is available' : current ? 'Your server is up to date' : 'Check for server updates';
  const healthy = current && !active && !recovery && !status?.build.custom;
  const attention = recovery || status?.build.custom || !!status?.error;
  const phase = phases.findIndex(p => p.states.includes(status?.job?.state ?? ''));
  return <>
    <PageHeader title="Server updates" description={<>Update Switchboard itself. <Link className={link} to="/admin/plugins">Manage plugin updates</Link></>}
      actions={<Button icon={<RefreshCw className="size-4" aria-hidden="true" />} loading={pending === 'check'} disabled={!status || active || offline} onClick={() => act('check')}>Check for updates</Button>} />
    <div className="max-w-5xl space-y-5">
      {error && <Alert>{error}</Alert>}
      {offline && <Alert tone="amber">Connection interrupted. This page will reconnect automatically. Requests to services are never replayed.</Alert>}
      {!status ? <p role="status" className="py-12 text-sm text-zinc-600 dark:text-zinc-400">Loading server update status…</p> : <>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-5">
            <section aria-labelledby="release-title" className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
              <div className="border-b border-zinc-100 px-5 py-6 sm:px-6 dark:border-zinc-800">
                <div className="flex items-start gap-3">
                  <div className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', healthy ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : attention ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400')}>
                    {healthy ? <CheckCircle2 className="size-5" aria-hidden="true" /> : <Server className="size-5" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0">
                    <h2 id="release-title" className="text-base font-semibold tracking-tight">{title}</h2>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{status.checkedAt ? `Last successful check: ${ago(status.checkedAt)}. Checks refresh daily.` : 'Check for a compatible release before upgrading.'}</p>
                  </div>
                </div>
                <dl className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div><dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Installed version</dt><dd className="mt-1 text-3xl font-semibold tracking-tight tabular-nums break-words">{status.build.version}</dd><dd className="mt-2"><Badge>{modes[status.build.mode] ?? status.build.mode}</Badge></dd></div>
                  {status.target && <div><dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{status.eligible ? 'Available version' : 'Latest checked version'}</dt><dd className={cx('mt-1 text-3xl font-semibold tracking-tight tabular-nums break-words', status.eligible && 'text-indigo-600 dark:text-indigo-400')}>{status.target.version}</dd><dd className="mt-2 text-sm"><a href={status.target.url} target="_blank" rel="noreferrer" className={link}>{status.channel === 'validated-main' ? 'View commit' : 'View release'}</a></dd></div>}
                </dl>
              </div>
              <div className="space-y-4 p-5 sm:p-6">
                <div className="max-w-xs space-y-1.5"><label htmlFor="release-channel" className="block text-sm font-medium">Release channel</label>
                  <Select id="release-channel" value={status.channel} disabled={busy || active || offline} onChange={async e => {
                    const channel = e.target.value;
                    if (channel === 'validated-main' && !await confirm({ title: 'Use validated main?', message: 'Follow development commits after CI passes. Stable releases are recommended for everyday use.', confirm: 'Use validated main' })) return;
                    await act('channel', { channel }, 'PUT');
                  }}><option value="stable">Stable releases</option><option value="validated-main" disabled={status.build.mode === 'runtime'}>Validated main</option></Select>
                  <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{status.build.mode === 'runtime' ? 'The macOS app uses prepared stable releases.' : status.channel === 'stable' ? 'Recommended for everyday use.' : 'Development commits that have passed upstream CI.'}</p>
                </div>
                {status.error && <Alert tone="amber">{status.error}</Alert>}
                {status.build.custom && <Alert tone="amber">This build is custom or has an unknown revision. Follow the setup guide to adopt a supported installation while preserving your data.</Alert>}
                {status.target && !status.eligible && !current && !status.error && !status.build.custom && <p className="text-sm text-zinc-600 dark:text-zinc-400">This release is not a newer compatible version of your running build.</p>}
                {recovery ? <Link className={link} to="/docs/guides/managed-upgrades#recovery">Follow the recovery steps</Link> : status.paired ? <div className="space-y-2">
                  <Button variant="primary" loading={pending === 'jobs'} icon={<ArrowUpCircle className="size-4" aria-hidden="true" />} disabled={!status.eligible || active || offline || busy} onClick={async () => {
                    if (await confirm({ title: `Upgrade to ${status.target?.version}?`, message: 'Preparation runs while the server stays available. The updater then pauses operations, disconnects streams, backs up all server data and restarts. Backup time is part of the interruption. Requests to services are never replayed.', confirm: 'Prepare upgrade' })) await act('jobs');
                  }}>{active ? 'Upgrade in progress' : status.eligible ? `Upgrade to ${status.target?.version}` : 'Upgrade server'}</Button>
                  {status.eligible && !active && <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">Preparation runs first. Backup and restart interrupt service.</p>}
                </div> : <p className="text-sm text-zinc-600 dark:text-zinc-400"><Link className={link} to="/docs/guides/managed-upgrades">Set up an updater</Link> to install server releases from this page.</p>}
              </div>
            </section>
            {status.job && <section aria-labelledby="outcome-title" aria-live="polite" className="space-y-4 rounded-xl bg-white p-5 ring-1 ring-zinc-200 sm:p-6 dark:bg-zinc-900 dark:ring-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="outcome-title" className="font-semibold">{states[status.job.state] ?? status.job.state}</h2><Badge tone={active ? 'indigo' : status.job.state === 'succeeded' ? 'green' : ['failed', 'recovery-required', 'rolled-back'].includes(status.job.state) ? 'amber' : 'neutral'}>{active ? 'In progress' : 'Last upgrade'}</Badge></div>
              {active && <><ol aria-label="Upgrade stages" className="grid grid-cols-3 gap-2">{phases.map((p, i) => <li key={p.label} aria-current={i === phase ? 'step' : undefined} className={cx('border-t-2 pt-2 text-xs font-medium', i <= phase ? 'border-indigo-500 text-indigo-700 dark:text-indigo-300' : 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400')}>{p.label}</li>)}</ol><p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">The updater keeps running if you close this page. The server reconnects here after restarting.</p></>}
              {status.job.error && <Alert tone="amber">{status.job.error} <Link to="/docs/guides/managed-upgrades#recovery" className="underline">Recovery steps</Link></Alert>}
              {status.job.durations && <dl className="flex flex-wrap gap-x-6 gap-y-3 text-sm">{Object.entries(status.job.durations).map(([key, ms]) => <div key={key}><dt className="capitalize text-zinc-600 dark:text-zinc-400">{key === 'outage' ? 'Service interruption' : key}</dt><dd className="mt-0.5 font-medium tabular-nums">{(ms / 1000).toFixed(1)} s</dd></div>)}</dl>}
              {['queued', 'preparing'].includes(status.job.state) && <Button loading={pending === 'jobs/cancel'} disabled={busy || offline} onClick={() => act('jobs/cancel')}>Cancel preparation</Button>}
            </section>}
            {status.target?.notes && <details className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"><summary className="cursor-pointer px-5 py-4 text-sm font-medium">Release notes · {status.target.version}</summary><p className="whitespace-pre-wrap break-words border-t border-zinc-100 px-5 py-4 text-sm leading-relaxed text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{status.target.notes}</p></details>}
            <details className="text-sm"><summary className="w-fit cursor-pointer py-1 font-medium text-zinc-600 dark:text-zinc-400">Build details</summary><dl className="mt-2 space-y-3 border-l border-zinc-200 pl-4 dark:border-zinc-800"><div><dt className="text-xs text-zinc-600 dark:text-zinc-400">Installed revision</dt><dd className="mt-1 break-all font-mono text-xs">{status.build.revision ?? 'Unavailable'}</dd></div>{status.target && <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">Checked release revision</dt><dd className="mt-1 break-all font-mono text-xs">{status.target.revision}</dd></div>}</dl></details>
          </div>
          <aside aria-labelledby="updater-title" className="min-w-0 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-2"><h2 id="updater-title" className="font-semibold">Server updater</h2><span role="status" aria-label="Updater connection"><Badge tone={status.paired ? 'green' : 'neutral'}>{status.paired ? 'Connected' : 'Not connected'}</Badge></span></div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{active ? 'Updater connection changes are paused until the current upgrade finishes.' : status.paired ? 'Ready to prepare releases, back up your data and restart this server.' : status.build.mode === 'runtime' ? 'Open Switchboard for macOS to start the server and reconnect its updater. Pairing is automatic.' : 'Runs alongside Switchboard and handles the backup and restart during an upgrade.'}</p>
            {!status.paired && !active && status.build.mode !== 'runtime' && <ol className="mt-5 space-y-4 text-sm">{['Start the updater for your installation.', 'Create a code and enroll it once.', 'Return here when it shows Connected.'].map((text, i) => <li key={text} className="flex gap-2.5"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{i + 1}</span><span className="min-w-0 leading-5">{text}</span></li>)}</ol>}
            <Link className={cx(link, 'mt-5 inline-flex items-center gap-2 text-sm')} to="/docs/guides/managed-upgrades"><BookOpen className="size-4" aria-hidden="true" />Setup guide</Link>
            {status.build.mode !== 'runtime' && <Link className={cx(link, 'mt-2 block text-sm')} to="/docs/guides/managed-upgrades#macos-app">macOS app setup</Link>}
            <div className="mt-5 border-t border-zinc-100 pt-5 dark:border-zinc-800">
              {!status.paired && status.build.mode !== 'runtime' ? <Button className="w-full" loading={pending === 'enrollment'} disabled={busy || active || offline} onClick={enroll}>Create enrollment code</Button> : <details><summary className="cursor-pointer py-1 text-sm font-medium text-zinc-600 dark:text-zinc-400">Manage connection</summary><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" loading={pending === 'enrollment'} disabled={busy || active || offline} onClick={enroll}>Create new code</Button><Button size="sm" loading={pending === 'disconnect'} disabled={busy || active || offline} onClick={async () => {
                if (await confirm({ title: 'Disconnect updater?', message: status.build.mode === 'runtime' ? 'The macOS app pairs automatically while it runs. Quit the app to keep its updater disconnected.' : 'Server upgrades will pause until you enroll an updater again.', confirm: 'Disconnect' })) { await act('enrollment', undefined, 'DELETE'); setEnrollment(undefined); }
              }}>Disconnect</Button></div></details>}
              {expired && <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Code expired. Create a new one to continue.</p>}
              {enrollment && <div className="mt-4 space-y-3"><p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">One-time code · expires after 10 minutes.</p><CopyField value={enrollment.code} />{status.build.mode === 'compose' ? <><p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">With the Compose example bundle, run this in its folder:</p><CopyField multiline value={`./switchboard enroll '${enrollment.code}'`} /></> : <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">Use the code in the launcher’s enroll command from the setup guide.</p>}<Button size="sm" variant="ghost" onClick={() => setEnrollment(undefined)}>Hide code</Button></div>}
            </div>
            <p className="mt-5 flex gap-2 border-t border-zinc-100 pt-4 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />Enrollment grants server upgrade access only.</p>
          </aside>
        </div>
      </>}
    </div>
  </>;
}
