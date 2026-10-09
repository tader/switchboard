import { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, GitBranch, MoreHorizontal, Puzzle, RefreshCw, ScrollText, Settings2, Trash2 } from 'lucide-react';
import { api, type Field, type PluginInfo } from '../api';
import { useSession } from '../auth';
import { FieldsForm, initialValues } from '../components/forms';
import {
  Alert, Badge, Button, CopyField, Dialog, Empty, FormField, IconButton, Input, Menu, PageHeader, ServiceIcon, Spinner, Switch, Table, Tabs, useConfirm, useToast,
} from '../components/ui';
import { ago, cx, useResource } from '../lib';
import { CommunityPlugins, PluginChangeDialog, type PluginChangeRequest } from '../components/PluginChanges';

type UpdateInfo = { id: string; ref: string | null; current: string; latest?: string; updateAvailable: boolean; error?: string };

const STATUS: Record<PluginInfo['status'], { label: string; tone: 'green' | 'red' | 'amber' | 'neutral' }> = {
  active: { label: 'Active', tone: 'green' },
  error: { label: 'Error', tone: 'red' },
  blocked: { label: 'Waiting', tone: 'amber' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

export function Plugins() {
  const toast = useToast();
  const confirm = useConfirm();
  const plugins = useResource(() => api<PluginInfo[]>('/admin/plugins'));
  const [filter, setFilter] = useState('');
  const [details, setDetails] = useState<PluginInfo | null>(null);
  const [tab, setTab] = useState<'installed' | 'community'>('installed');
  const [changeRequest, setChangeRequest] = useState<PluginChangeRequest | null>(null);
  const [settings, setSettings] = useState<PluginInfo | null>(null);
  const [logs, setLogs] = useState<PluginInfo | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateInfo>>({});
  const [checking, setChecking] = useState(false);
  const updatingAll = changeRequest?.kind === 'update';
  const [updateErrors, setUpdateErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await fn();
      if (done) toast(done);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
      plugins.reload();
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    setUpdateErrors([]);
    try {
      const list = await api<UpdateInfo[]>('/admin/plugins/check-updates', { method: 'POST' });
      setUpdates(Object.fromEntries(list.map((u) => [u.id, u])));
      setUpdateErrors(list.filter((u) => u.error).map((u) => `${plugins.data?.find((p) => p.id === u.id)?.name ?? u.id}: ${u.error}`));
      const n = list.filter(u => u.updateAvailable && plugins.data?.some(p => p.id === u.id && p.source?.commit === u.current && (p.source?.ref ?? null) === u.ref)).length;
      toast(list.length ? (n ? `${n} update${n > 1 ? 's' : ''} available` : list.some((u) => u.error) ? 'Some update checks failed' : 'Everything is up to date') : 'No plugins installed from GitHub', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const updateFor = (plugin: PluginInfo) => {
    const checked = updates[plugin.id];
    return plugin.source && checked?.current === plugin.source.commit && checked.ref === (plugin.source.ref ?? null) ? checked : undefined;
  };
  const availableUpdates = (plugins.data ?? []).filter(p => updateFor(p)?.updateAvailable);
  const updateAll = () => {
    if (!busy && !checking && availableUpdates.length) setChangeRequest({ kind: 'update', plugins: availableUpdates });
  };

  const byId = new Map(plugins.data?.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Plugins"
        actions={
          <>
            {availableUpdates.length || updatingAll ? <Button icon={<ArrowUpCircle className="size-4" />} loading={updatingAll} disabled={checking || !!busy || updatingAll} onClick={updateAll}>
              {`Update all (${availableUpdates.length})`}
            </Button> : <Button icon={<RefreshCw className="size-4" />} loading={checking} disabled={checking || !!busy || updatingAll} onClick={checkUpdates}>
              Check for updates
            </Button>}
            <Button variant="primary" icon={<Download className="size-4" />} disabled={updatingAll} onClick={() => setChangeRequest({ kind: 'install' })}>
              Install
            </Button>
          </>
        }
      />
      {updateErrors.length > 0 && <Alert><ul className="space-y-1">{updateErrors.map((error, i) => <li key={i}>{error}</li>)}</ul></Alert>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'installed', label: 'Installed' }, { value: 'community', label: 'Community' }]} className="mb-4" />
      {tab === 'community' ? <CommunityPlugins installed={plugins.data ?? []} onInstall={(initial) => setChangeRequest({ kind: 'install', initial })} /> : plugins.loading && !plugins.data ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : !plugins.data?.length ? (
        <Empty icon={<Puzzle className="size-5" />} title="No plugins" action={<Button variant="primary" onClick={() => setChangeRequest({ kind: 'install' })}>Install from GitHub</Button>} />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3"><Input aria-label="Search plugins" placeholder="Search plugins…" value={filter} onChange={e => setFilter(e.target.value)} className="max-w-sm" /><span className="shrink-0 text-xs text-zinc-500">{plugins.data.filter(p => `${p.name} ${p.description ?? ''} ${p.id} ${p.services.map(s => s.name).join(' ')}`.toLowerCase().includes(filter.trim().toLowerCase())).length} of {plugins.data.length}</span></div>
          <Table label="Plugins"><thead><tr>
            <th scope="col">Plugin</th>
            <th scope="col" className="hidden w-20 sm:table-cell">Version</th>
            <th scope="col" className="w-24">Status</th>
            <th scope="col" className="hidden w-[28%] lg:table-cell">Source</th>
            <th scope="col" className="w-24 sm:w-32"><span className="sr-only">Actions</span></th>
          </tr></thead><tbody>
          {plugins.data.filter(p => `${p.name} ${p.description ?? ''} ${p.id} ${p.services.map(s => s.name).join(' ')}`.toLowerCase().includes(filter.trim().toLowerCase())).map((p) => {
            const st = STATUS[p.status];
            const upd = updateFor(p);
            return (
              <tr key={p.id} className={cx(!p.enabled && 'opacity-70')}>
                <td><div className="flex min-w-0 items-center gap-2"><ServiceIcon icon={p.icon} name={p.name} size="sm" /><div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setDetails(p)} className="block max-w-full truncate font-semibold hover:text-indigo-600 dark:hover:text-indigo-400" title={p.name}>{p.name}</button>
                  {p.description && <div className="truncate text-xs text-zinc-500" title={p.description}>{p.description}</div>}
                  {p.error && p.status !== 'disabled' && <div className="truncate text-xs text-rose-600 dark:text-rose-400" title={p.error}>{p.error}</div>}
                </div></div></td>
                <td className="hidden font-mono text-xs text-zinc-500 sm:table-cell">{p.version}</td>
                <td><Badge tone={st.tone}>{st.label}</Badge>{upd?.updateAvailable && <div className="mt-1"><Badge tone="indigo">Update</Badge></div>}</td>
                <td className="hidden lg:table-cell">{p.source ? <a href={`https://github.com/${p.source.repo}/tree/${p.source.commit}/${p.source.path}`} target="_blank" rel="noreferrer" className="block min-w-0 hover:text-indigo-600 dark:hover:text-indigo-400" title={`${p.source.repo}/${p.source.path}`}><span className="block truncate text-xs">{p.source.repo}{p.source.path && `/${p.source.path}`}</span><span className="block truncate text-xs text-zinc-500">{p.source.ref ?? 'Default branch'} <span className="font-mono">@{p.source.commit.slice(0, 7)}</span></span></a> : <span className="text-xs text-zinc-500">Built in</span>}</td>
                <td><div className="flex items-center justify-end gap-1">

                    {busy === p.id && <Spinner className="mr-1" />}
                    {p.hasSettings && (
                      <IconButton label={`Settings for ${p.name}`} disabled={updatingAll} onClick={() => setSettings(p)}><Settings2 className="size-3.5" /></IconButton>
                    )}
                    <Switch
                      label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
                      checked={p.enabled}
                      disabled={updatingAll || busy === p.id}
                      onChange={async (v) => {
                        if (!v && p.dependents.length) {
                          const ok = await confirm({
                            title: `Disable ${p.name}?`,
                            message: <>These plugins depend on it and will stop too: {p.dependents.join(', ')}.</>,
                            confirm: 'Disable',
                          });
                          if (!ok) return;
                        }
                        run(p.id, () => api(`/admin/plugins/${p.id}`, { method: 'PATCH', body: { enabled: v } }));
                      }}
                    />
                    <Menu
                      trigger={(t) => (
                        <IconButton label={`Actions for ${p.name}`} disabled={updatingAll || busy === p.id} {...t}>
                          <MoreHorizontal className="size-4" />
                        </IconButton>
                      )}
                      items={[
                        {
                          label: upd?.updateAvailable ? 'Update now' : 'Update',
                          icon: <ArrowUpCircle />,
                          hidden: !p.source,
                          onSelect: () => setChangeRequest({ kind: 'update', plugins: [p] }),
                        },
                        { label: 'Update from…', icon: <GitBranch />, hidden: !p.source, onSelect: () => setChangeRequest({ kind: 'update', plugins: [p], editRef: true }) },
                        { label: 'Reload', icon: <RefreshCw />, onSelect: () => run(p.id, () => api(`/admin/plugins/${p.id}/reload`, { method: 'POST' }), `${p.name} reloaded`) },
                        { label: 'Log', icon: <ScrollText />, onSelect: () => setLogs(p) },
                        ...(p.origin === 'installed'
                          ? [
                              'separator' as const,
                              {
                                label: 'Uninstall',
                                icon: <Trash2 />,
                                danger: true,
                                onSelect: async () => {
                                  const ok = await confirm({
                                    title: `Uninstall ${p.name}?`,
                                    message: p.overridesBuiltin
                                      ? 'The built-in version will be used again.'
                                      : 'Connections that use its services stop working until it is installed again. They are not deleted.',
                                    confirm: 'Uninstall',
                                    danger: true,
                                  });
                                  if (ok) run(p.id, () => api(`/admin/plugins/${p.id}`, { method: 'DELETE' }), `${p.name} uninstalled`);
                                },
                              },
                            ]
                          : []),
                      ]}
                    />
                </div></td>
              </tr>
            );
          })}
          </tbody></Table>
        </div>
      )}
      <Dialog open={!!details} onClose={() => setDetails(null)} title={details?.name ?? 'Plugin'}>
        {details && <div className="space-y-3 text-[13px]">
          <p className="text-zinc-500">{details.description}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-zinc-500">Version</dt><dd>{details.version}</dd>
            <dt className="text-zinc-500">Source</dt><dd className="break-all">{details.source ? <a href={`https://github.com/${details.source.repo}/tree/${details.source.commit}/${details.source.path}`} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400">{details.source.repo}/{details.source.path} · {details.source.ref ?? 'Default branch'} @{details.source.commit.slice(0, 7)}</a> : 'Built in'}{details.overridesBuiltin && ' · Replaces the built-in version'}</dd>
            <dt className="text-zinc-500">Uses</dt><dd>{details.dependencies.length ? details.dependencies.map(d => <span key={d} className={cx('mr-2', byId.get(d)?.status !== 'active' && 'text-rose-600 dark:text-rose-400')}>{d}{details.dependencyVersions?.[d] && ` ${details.dependencyVersions[d]}`}</span>) : 'None'}</dd>
            <dt className="text-zinc-500">Provides</dt><dd>{details.services.map(s => s.name).join(', ') || 'No services'}</dd>
          </dl>
          {details.error && <Alert>{details.error}</Alert>}
        </div>}
      </Dialog>
      <PluginChangeDialog request={changeRequest} onClose={() => setChangeRequest(null)} onApplied={(list) => {
        setChangeRequest(null);
        setUpdates({});
        plugins.reload();
        toast(`Applied changes to ${list.map((p) => p.name).join(', ')}`);
      }} />
      <SettingsDialog plugin={settings} onClose={() => setSettings(null)} onSaved={() => { setSettings(null); plugins.reload(); toast('Settings saved'); }} />
      <LogDialog plugin={logs} onClose={() => setLogs(null)} />
    </>
  );
}

function SettingsDialog({ plugin, onClose, onSaved }: { plugin: PluginInfo | null; onClose: () => void; onSaved: () => void }) {
  const { info } = useSession();
  const [data, setData] = useState<{ fields: Field[]; values: Record<string, any>; secretsSet: string[] } | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!plugin) return;
    setData(null);
    setError('');
    api(`/admin/plugins/${plugin.id}/settings`).then(
      (d) => {
        setData(d);
        setValues(initialValues(d.fields, d.values));
      },
      (e) => setError(e.message),
    );
  }, [plugin]);
  const usesOAuth = plugin && (plugin.id === 'oauth2' || plugin.dependencies.includes('oauth2') || plugin.dependencies.includes('google'));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    // Empty secret fields keep their stored value.
    const body = Object.fromEntries(Object.entries(values).filter(([k, v]) => !(data!.secretsSet.includes(k) && v === '')));
    try {
      await api(`/admin/plugins/${plugin!.id}/settings`, { method: 'PUT', body });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!plugin} onClose={onClose} title={`${plugin?.name} settings`} description="Shared by everyone using this plugin.">
      {!data ? (
        error ? <Alert>{error}</Alert> : <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {usesOAuth && (
            <FormField label="Redirect URI" description="Register this at the provider for the OAuth client.">
              <CopyField value={info.callbackUrl} />
            </FormField>
          )}
          <FieldsForm fields={data.fields} values={values} onChange={setValues} secretsSet={data.secretsSet} idPrefix={`settings-${plugin?.id}`} />
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function LogDialog({ plugin, onClose }: { plugin: PluginInfo | null; onClose: () => void }) {
  const detail = useResource(async () => (plugin ? api<PluginInfo>(`/admin/plugins/${plugin.id}`) : null), [plugin?.id]);
  return (
    <Dialog open={!!plugin} onClose={onClose} title={`${plugin?.name} log`} description={detail.data?.loadedAt ? `Loaded ${ago(detail.data.loadedAt).toLowerCase()}` : undefined} size="lg">
      {!detail.data ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !detail.data.logs?.length ? (
        <p className="text-[13px] text-zinc-500">Nothing logged yet.</p>
      ) : (
        <div className="rounded-lg bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-200">
          {detail.data.logs.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0 text-zinc-500">{new Date(l.at).toLocaleTimeString()}</span>
              <span className={cx('break-all', l.level === 'error' && 'text-rose-400', l.level === 'warn' && 'text-amber-300')}>{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
