import { useEffect, useState } from 'react';
import { Download, Puzzle, RefreshCw } from 'lucide-react';
import { api, type CommunityPlugin, type Connection, type PluginCatalog, type PluginInfo, type PluginPlan } from '../api';
import { Alert, Badge, Button, Dialog, Empty, FormField, Input, Select, Spinner, Switch, Table, ServiceIcon } from './ui';

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
    <p className="text-[13px] text-zinc-500">Browse plugins from the <a className="text-indigo-600 dark:text-indigo-400" href="https://github.com/tader/switchboard-plugins" target="_blank" rel="noreferrer">community catalog</a>. Listings are loaded when you open this browser.</p>
    {error && <Alert>{error} <Button size="sm" disabled={loading} onClick={() => void load()}>Retry</Button></Alert>}
    {loading && !catalog ? <div className="flex justify-center py-12"><Spinner /></div> : !visible.length && !error ? <Empty icon={<Puzzle className="size-5" />} title={filter ? 'No matching plugins' : 'No community plugins yet'} /> : catalog && <Table label="Community plugins">
      <thead><tr><th scope="col">Plugin</th><th scope="col" className="hidden sm:table-cell">Repository</th><th scope="col"><span className="sr-only">Install</span></th></tr></thead>
      <tbody>{visible.map((p) => {
        const present = installed.find((i) => i.id === p.id);
        return <tr key={p.id}>
          <td><div className="flex min-w-0 items-start gap-2"><ServiceIcon icon={p.icon} name={p.name} size="sm" /><div className="min-w-0"><div className="font-semibold">{p.name}</div><p className="mt-1 text-xs text-zinc-500">{p.description}</p></div></div></td>
          <td className="hidden sm:table-cell"><a className="break-all text-xs text-indigo-600 dark:text-indigo-400" href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer">{p.repo}</a></td>
          <td className="text-right">{present?.origin === 'installed' ? <Badge>Installed</Badge> : <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => onInstall(p)}>{present ? 'Install external version' : 'Install'}</Button>}</td>
        </tr>;
      })}</tbody>
    </Table>}
  </div>;
}

export function PluginChangeDialog({ request, onClose, onApplied }: { request: PluginChangeRequest | null; onClose: () => void; onApplied: (plugins: PluginInfo[]) => void }) {
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [useDefault, setUseDefault] = useState(true);
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
    setRepo(initial?.repo ?? ''); setSubpath(initial?.path ?? ''); setRef(initial?.ref ?? source?.ref ?? '');
    setUseDefault(!source?.ref); setConnection(request.kind === 'update' ? 'remembered' : 'automatic');
    setPlan(null); setError(''); setConnectionError(''); setConnections([]);
    const controller = new AbortController();
    api<Connection[]>('/connections', { signal: controller.signal }).then((list) => {
      setConnections(list.filter((c) => c.serviceId === 'github' && c.kind === 'http' && !c.satellite && c.status !== 'unavailable'));
    }, (e) => { if (!controller.signal.aborted) setConnectionError(e.message); });
    return () => controller.abort();
  }, [request]);
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
          setPlan(await api<PluginPlan>('/admin/plugins/install/plan', { body: { repo, ref, path: subpath, githubConnectionId, expectedId: request.initial?.id } }));
        } else {
          setPlan(await api<PluginPlan>('/admin/plugins/update/plan', { body: { updates: request.plugins.map((p) => ({ id: p.id, ...(request.editRef ? { ref: useDefault ? null : ref.trim() } : {}), githubConnectionId })) } }));
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
          <p className="mt-1 break-all text-xs text-zinc-500">{c.source.repo}{c.source.path && `/${c.source.path}`} · {c.source.ref ?? 'Default branch'} @{c.source.commit.slice(0, 7)}</p>
        </div>)}</div>
        {plan.affectedDependents.length > 0 && <p className="text-[13px] text-zinc-500">Also reloads: {plan.affectedDependents.join(', ')}.</p>}
        {plan.requiresReview && <Alert tone="amber">This upgrades a shared dependency. Switchboard checked the version requirements of the enabled plugins that use it.</Alert>}
      </> : <>
        {!updating && <>
          <FormField label="Repository" htmlFor="plugin-repo" description="owner/repo or a GitHub folder URL. Without a folder, every plugin in the repository is selected.">
            <Input id="plugin-repo" value={repo} onChange={(e) => setRepo(e.target.value)} required autoFocus disabled={busy} spellCheck={false} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Branch, tag or commit" htmlFor="plugin-ref" optional><Input id="plugin-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Default branch" disabled={busy} spellCheck={false} /></FormField>
            <FormField label="Folder" htmlFor="plugin-path" optional><Input id="plugin-path" value={subpath} onChange={(e) => setSubpath(e.target.value)} placeholder="/" disabled={busy} spellCheck={false} /></FormField>
          </div>
        </>}
        {request?.kind === 'update' && <>
          <p className="break-all text-[13px] text-zinc-500">{request.plugins.map((p) => p.name).join(', ')}</p>
          {request.editRef ? <>
            <div className="flex items-center gap-2 text-[13px]"><Switch label="Use default branch" checked={useDefault} onChange={setUseDefault} disabled={busy} /><span>Use default branch</span></div>
            {!useDefault && <FormField label="Branch, tag or commit" htmlFor="plugin-update-ref" description="Future updates follow this ref."><Input id="plugin-update-ref" value={ref} onChange={(e) => setRef(e.target.value)} required disabled={busy} spellCheck={false} /></FormField>}
          </> : <p className="text-xs text-zinc-500">Each plugin keeps its tracked branch, tag or commit.</p>}
        </>}
        <FormField label="GitHub access" htmlFor="plugin-connection" description="Automatic access tries public access, the configured token, and your local GitHub connections.">
          <Select id="plugin-connection" value={connection} onChange={(e) => setConnection(e.target.value)} disabled={busy}>
            {updating && <option value="remembered">Remembered choices, then automatic</option>}
            <option value="automatic">Automatic</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.account?.label ? ` (${c.account.label})` : ''}</option>)}
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
