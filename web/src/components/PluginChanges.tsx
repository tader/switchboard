import { ListToolbar, ListFeedback, SortHeader, useList } from './ListControls';
import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api, type CommunityPlugin, type Connection, type PluginCatalog, type PluginInfo, type PluginPlan } from '../api';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Spinner, Table, ServiceIcon } from './ui';

export type PluginChangeRequest =
  | { kind: 'install'; initial?: CommunityPlugin }
  | { kind: 'update'; plugins: PluginInfo[]; editRef?: boolean };

export function CommunityPlugins({ installed, onInstall }: { installed: PluginInfo[]; onInstall: (listing: CommunityPlugin) => void }) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [details, setDetails] = useState<CommunityPlugin | null>(null);
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
  const installation = (p: CommunityPlugin) => { const present = installed.find(i => i.id === p.id); return present?.origin === 'installed' ? 'installed' : present ? 'builtin' : 'available'; };
  const list = useList('plugins-community', catalog?.plugins ?? [], { search: p => [p.id, p.name, p.description, p.repo], sorts: { name: p => p.name, source: p => p.repo, status: installation }, filters: { status: '', source: '' }, filter: (p, f) => (!f.status || installation(p) === f.status) && (!f.source || p.repo === f.source) });
  return <div className="space-y-3">
    <ListToolbar list={list} label="community plugins" placeholder="Search plugins…" sorts={[{ value: 'name', label: 'Name' }, { value: 'source', label: 'Source' }, { value: 'status', label: 'Status' }]}>
      <Select aria-label="Community installation state" value={list.state.status} onChange={e => list.set({ status: e.target.value })} className="w-40"><option value="">Any status</option><option value="available">Not installed</option><option value="installed">Installed</option><option value="builtin">Built in only</option></Select>
      <Select aria-label="Community repository" value={list.state.source} onChange={e => list.set({ source: e.target.value })} className="w-44"><option value="">All repositories</option>{[...new Set(catalog?.plugins.map(p => p.repo))].sort().map(repo => <option key={repo} value={repo}>{repo}</option>)}</Select>
      <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>Refresh</Button>
    </ListToolbar>
    <ListFeedback loading={loading && !catalog} error={error ? new Error(error) : undefined} empty={!list.visible.length} filtered={list.filtered} label="community plugins" retry={() => void load()} reset={list.reset} />
    {!!list.visible.length && <Table label="Community plugins"><thead><tr><SortHeader list={list} field="name">Plugin</SortHeader><SortHeader list={list} field="status" className="w-28">Status</SortHeader><SortHeader list={list} field="source" className="hidden w-[28%] lg:table-cell">Source</SortHeader><th className="w-24 sm:w-32"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{list.visible.map(p => { const state = installation(p); return <tr key={p.id}>
        <td><div className="flex min-w-0 items-center gap-2"><ServiceIcon icon={p.icon} name={p.name} size="sm" /><div className="min-w-0"><button type="button" onClick={() => setDetails(p)} className="block max-w-full truncate text-left font-semibold hover:text-indigo-600 dark:hover:text-indigo-400" title={p.name}>{p.name}</button><div className="truncate text-xs text-zinc-500" title={p.description}>{p.description}</div></div></div></td>
        <td><Badge tone={state === 'installed' ? 'green' : 'neutral'}>{state === 'installed' ? 'Installed' : state === 'builtin' ? 'Built in' : 'Available'}</Badge></td><td className="hidden lg:table-cell"><a className="block truncate text-xs text-zinc-500 hover:text-indigo-600 dark:hover:text-indigo-400" href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" title={p.repo}>{p.repo}</a></td>
        <td className="text-right">{state !== 'installed' && <Button size="sm" icon={<Download className="size-3.5" />} title={state === 'builtin' ? 'Install external version' : undefined} onClick={() => onInstall(p)}>Install</Button>}</td>
      </tr>; })}</tbody>
    </Table>}
    <Dialog open={!!details} onClose={() => setDetails(null)} title={details?.name ?? 'Plugin'}>{details && <div className="space-y-3 text-[13px]"><p className="text-zinc-500">{details.description}</p><a href={`https://github.com/${details.repo}`} target="_blank" rel="noreferrer" className="break-all text-indigo-600 dark:text-indigo-400">{details.repo}</a><div className="flex justify-end"><Button onClick={() => setDetails(null)}>Done</Button></div></div>}</Dialog>
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
