import { useEffect, useState } from 'react';
import { Download, Puzzle, RefreshCw } from 'lucide-react';
import { api, type CommunityPlugin, type Connection, type PluginCatalog, type PluginInfo, type PluginPlan } from '../api';
import { Alert, Badge, Button, Dialog, Empty, FormField, Input, Select, Spinner, Table, ServiceIcon } from './ui';

export type PluginChangeRequest =
  | { kind: 'install'; initial?: CommunityPlugin }
  | { kind: 'update'; plugins: PluginInfo[]; editRef?: boolean };

export function CommunityPlugins({ installed, onInstall }: { installed: PluginInfo[]; onInstall: (listing: CommunityPlugin) => void }) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try { setCatalog(await api<PluginCatalog>('/admin/plugins/community', { signal })); }
    catch (e: any) { if (!signal?.aborted) setError(e.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  const visible = catalog?.plugins.filter((p) => `${p.id} ${p.name} ${p.description} ${p.repo}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return <div className="space-y-4">
    <div className="flex items-center gap-3">
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search community plugins…" aria-label="Search community plugins" className="max-w-sm" />
      <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>Refresh</Button>
    </div>
    {error && <Alert>{error} <Button size="sm" disabled={loading} onClick={() => void load()}>Retry</Button></Alert>}
    {loading && !catalog ? <div className="flex justify-center py-12"><Spinner /></div> : !visible.length && !error ? <Empty icon={<Puzzle className="size-5" />} title={filter ? 'No matching plugins' : 'No community plugins yet'} /> : catalog && <Table label="Community plugins" layout="auto">
      <thead><tr><th scope="col">Plugin</th><th scope="col" className="w-px whitespace-nowrap"><span className="sr-only">Install</span></th></tr></thead>
      <tbody>{visible.map((p) => {
        const present = installed.find((i) => i.id === p.id);
        return <tr key={p.id}>
          <td><div className="flex min-w-0 items-start gap-2"><ServiceIcon icon={p.icon} name={p.name} size="sm" /><div className="min-w-0"><div className="font-semibold">{p.name}</div><p className="mt-1 text-xs text-zinc-500">{p.description}</p><a className="mt-1 block break-all text-xs text-indigo-600 dark:text-indigo-400" href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer">{p.repo}</a></div></div></td>
          <td className="w-px whitespace-nowrap text-right">{present?.origin === 'installed' ? <Badge>Installed</Badge> : <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => onInstall(p)}>{present ? 'Install external version' : 'Install'}</Button>}</td>
        </tr>;
      })}</tbody>
    </Table>}
  </div>;
}

export function PluginChangeDialog({ request, onClose, onApplied }: { request: PluginChangeRequest | null; onClose: () => void; onApplied: (plugins: PluginInfo[]) => void }) {
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [channel, setChannel] = useState<'latest' | 'release' | 'branch'>('latest');
  const [releases, setReleases] = useState<{ tag: string; name: string; prerelease: boolean }[]>([]);
  const [releaseError, setReleaseError] = useState('');
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [connection, setConnection] = useState('automatic');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PluginPlan | null>(null);
  useEffect(() => {
    if (!request) return;
    const initial = request.kind === 'install' ? request.initial : undefined;
    const source = request.kind === 'update' && request.plugins.length === 1 ? request.plugins[0].source : undefined;
    setRepo(initial?.repo ?? source?.repo ?? ''); setSubpath(initial?.path ?? source?.path ?? ''); setRef(initial?.ref ?? source?.ref ?? '');
    setChannel(source?.channel ?? (source?.ref || initial?.ref ? 'branch' : 'latest')); setReleases([]); setReleaseError(''); setConnection(request.kind === 'update' ? 'remembered' : 'automatic');
    setPlan(null); setError(''); setConnectionError(''); setConnections([]);
    const controller = new AbortController();
    api<Connection[]>('/connections', { signal: controller.signal }).then((list) => {
      setConnections(list.filter((c) => c.kind === 'http' && (c.peer ? /^(?:peer\/[A-Za-z0-9_-]+\/)+github$/.test(c.serviceId) : c.serviceId === 'github') && c.status !== 'unavailable'));
    }, (e) => { if (!controller.signal.aborted) setConnectionError(e.message); });
    return () => controller.abort();
  }, [request]);
  const choosingChannel = request?.kind === 'install' || (request?.kind === 'update' && request.editRef);
  useEffect(() => {
    setReleases([]); setReleaseError('');
    if (!request || !choosingChannel || channel === 'branch' || !repo.trim()) { setLoadingReleases(false); return; }
    const controller = new AbortController();
    setLoadingReleases(true);
    const timer = setTimeout(() => {
      void api<typeof releases>('/admin/plugins/releases', { signal: controller.signal, body: {
        repo, path: subpath, githubConnectionId: connection === 'remembered' ? undefined : connection === 'automatic' ? null : connection,
        pluginId: request.kind === 'update' ? request.plugins[0]?.id : undefined,
      } }).then((list) => { if (!controller.signal.aborted) setReleases(list); }, (e) => {
        if (!controller.signal.aborted) setReleaseError(e.message);
      }).finally(() => { if (!controller.signal.aborted) setLoadingReleases(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [request, choosingChannel, channel, repo, subpath, connection]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!request) return;
    setBusy(true); setError('');
    try {
      if (plan) {
        const result = await api<{ plugins: PluginInfo[] }>('/admin/plugins/apply', { body: { planId: plan.planId } });
        onApplied(result.plugins);
      } else {
        const githubConnectionId = connection === 'remembered' ? undefined : connection === 'automatic' ? null : connection;
        if (request.kind === 'install') {
          setPlan(await api<PluginPlan>('/admin/plugins/install/plan', { body: { repo, channel, ...(channel !== 'latest' && ref.trim() ? { ref: ref.trim() } : {}), path: subpath, githubConnectionId, expectedId: request.initial?.id } }));
        } else {
          setPlan(await api<PluginPlan>('/admin/plugins/update/plan', { body: { updates: request.plugins.map((p) => ({ id: p.id, ...(request.editRef ? { channel, ...(channel !== 'latest' ? { ref: ref.trim() || null } : {}) } : {}), githubConnectionId })) } }));
        }
      }
    } catch (e: any) {
      setError(e.message);
      if (e.status === 409) setPlan(null);
    } finally { setBusy(false); }
  };
  const updating = request?.kind === 'update';
  const title = plan ? 'Review plugin changes' : updating ? request.plugins.length > 1 ? `Update ${request.plugins.length} plugins` : `Update ${request.plugins[0]?.name ?? 'plugin'}` : 'Install from GitHub';
  return <Dialog open={!!request} onClose={() => { if (!busy) onClose(); }} title={title}>
    <form onSubmit={submit} className="space-y-4">
      {plan ? <>
        <div className="space-y-3">{plan.changes.map((c) => <div key={c.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{c.name}</span><Badge>{c.dependency ? 'Dependency' : c.action === 'install' ? 'Install' : 'Update'}</Badge></div>
          <p className="mt-1 text-xs">{c.fromVersion ? `${c.fromVersion} → ${c.version}` : c.version}</p>
          <p className="mt-1 break-all text-xs text-zinc-500">{c.source.repo}{c.source.path && `/${c.source.path}`} · {pluginSourceLabel(c.source)} @{c.source.commit.slice(0, 7)}</p>
        </div>)}</div>
        {plan.affectedDependents.length > 0 && <p className="text-[13px] text-zinc-500">Also reloads: {plan.affectedDependents.join(', ')}.</p>}
        {plan.requiresReview && <Alert tone="amber">This upgrades a shared dependency. Switchboard checked the version requirements of the enabled plugins that use it.</Alert>}
      </> : <>
        {!updating && <>
          <FormField label="Repository" htmlFor="plugin-repo" description="owner/repo or a GitHub folder URL. Without a folder, every plugin in the repository is selected.">
            <Input id="plugin-repo" value={repo} onChange={(e) => setRepo(e.target.value)} required autoFocus disabled={busy} spellCheck={false} />
          </FormField>
          <FormField label="Folder" htmlFor="plugin-path" optional><Input id="plugin-path" value={subpath} onChange={(e) => setSubpath(e.target.value)} placeholder="/" disabled={busy} spellCheck={false} /></FormField>
        </>}
        {request?.kind === 'update' && <>
          <p className="break-all text-[13px] text-zinc-500">{request.plugins.map((p) => p.name).join(', ')}</p>
          {!request.editRef && <p className="text-xs text-zinc-500">Each plugin keeps its release or development branch setting. Pinned releases stay pinned.</p>}
        </>}
        {choosingChannel && <>
          <FormField label="Updates" htmlFor="plugin-channel">
            <Select id="plugin-channel" value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setRef(''); }} disabled={busy}>
              <option value="latest">Latest release (recommended)</option>
              <option value="release">Pin a release</option>
              <option value="branch">Development branch</option>
            </Select>
          </FormField>
          {channel === 'latest' && <p className="text-xs text-zinc-500">Installs the latest stable release. Future updates follow new stable releases.</p>}
          {channel === 'release' && <FormField label="Release" htmlFor="plugin-release" description="Pinned releases are excluded from update checks.">
            <Select id="plugin-release" value={ref} onChange={(e) => setRef(e.target.value)} required disabled={busy || loadingReleases}>
              <option value="">Choose a release…</option>
              {releases.map((release) => <option key={release.tag} value={release.tag}>{release.tag}{release.prerelease ? ' (prerelease)' : ''}{release.name !== release.tag ? ` — ${release.name}` : ''}</option>)}
            </Select>
          </FormField>}
          {channel === 'branch' && <FormField label="Branch" htmlFor="plugin-ref" description="Development code runs with full access to Switchboard. Leave empty to follow the repository’s default branch.">
            <Input id="plugin-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Default branch" disabled={busy} spellCheck={false} />
          </FormField>}
          {loadingReleases && <p className="flex items-center gap-2 text-xs text-zinc-500"><Spinner /> Loading releases…</p>}
          {releaseError && <Alert>{releaseError}</Alert>}
          {channel !== 'branch' && repo.trim() && !loadingReleases && !releaseError && !releases.some((r) => channel === 'release' || !r.prerelease) && <Alert>No {channel === 'latest' ? 'stable ' : ''}releases available. For repositories with separate plugin releases, choose a plugin folder. You can also select a development branch.</Alert>}
        </>}
        <FormField label="GitHub access" htmlFor="plugin-connection" description="Automatic access tries public access, the configured token, and your accessible GitHub connections, including shared peer connections.">
          <Select id="plugin-connection" value={connection} onChange={(e) => setConnection(e.target.value)} disabled={busy}>
            {updating && <option value="remembered">Remembered choices, then automatic</option>}
            <option value="automatic">Automatic</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.peer ? ` (${c.peer.name})` : c.account?.label ? ` (${c.account.label})` : ''}</option>)}
          </Select>
        </FormField>
        {connectionError && <Alert>Could not load the GitHub connection picker: {connectionError}</Alert>}
      </>}
      <Alert tone="amber">Plugins run inside Switchboard and can read every credential it stores. Only install plugins you trust.</Alert>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {plan && <Button disabled={busy} onClick={() => { setPlan(null); setError(''); }}>Back</Button>}
        <Button type="submit" variant="primary" loading={busy}>{plan ? updating ? 'Apply update' : 'Install' : 'Review changes'}</Button>
      </div>
    </form>
  </Dialog>;
}

export function pluginSourceLabel(source: NonNullable<PluginInfo['source']>): string {
  const channel = source.channel ?? (source.ref ? 'branch' : 'latest');
  return channel === 'latest' ? `Latest release${source.ref ? ` · ${source.ref}` : ''}` : channel === 'release' ? `Pinned · ${source.ref}` : `Development · ${source.ref ?? 'Default branch'}`;
}
