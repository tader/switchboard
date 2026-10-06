import { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, GitBranch, MoreHorizontal, Puzzle, RefreshCw, ScrollText, Settings2, Trash2 } from 'lucide-react';
import { api, type Field, type PluginInfo } from '../api';
import { useSession } from '../auth';
import { FieldsForm, initialValues } from '../components/forms';
import {
  Alert, Badge, Button, Card, CopyField, Dialog, Empty, FormField, IconButton, Input, Menu, PageHeader, ServiceIcon, Spinner, Switch, useConfirm, useToast,
} from '../components/ui';
import { ago, cx, useResource } from '../lib';

type UpdateInfo = { id: string; current: string; latest?: string; updateAvailable: boolean; error?: string };

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
  const [installOpen, setInstallOpen] = useState(false);
  const [settings, setSettings] = useState<PluginInfo | null>(null);
  const [logs, setLogs] = useState<PluginInfo | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateInfo>>({});
  const [checking, setChecking] = useState(false);
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
    try {
      const list = await api<UpdateInfo[]>('/admin/plugins/check-updates', { method: 'POST' });
      setUpdates(Object.fromEntries(list.map((u) => [u.id, u])));
      const n = list.filter((u) => u.updateAvailable).length;
      toast(list.length ? (n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date') : 'No plugins installed from GitHub', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const byId = new Map(plugins.data?.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Plugins"
        actions={
          <>
            <Button icon={<RefreshCw className="size-4" />} loading={checking} onClick={checkUpdates}>
              Check for updates
            </Button>
            <Button variant="primary" icon={<Download className="size-4" />} onClick={() => setInstallOpen(true)}>
              Install
            </Button>
          </>
        }
      />
      {plugins.loading && !plugins.data ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : !plugins.data?.length ? (
        <Empty icon={<Puzzle className="size-5" />} title="No plugins" action={<Button variant="primary" onClick={() => setInstallOpen(true)}>Install from GitHub</Button>} />
      ) : (
        <div className="grid gap-3">
          {plugins.data.map((p) => {
            const st = STATUS[p.status];
            const upd = updates[p.id];
            return (
              <Card key={p.id} className={cx('p-4', !p.enabled && 'opacity-70')}>
                <div className="flex items-start gap-3.5">
                  <ServiceIcon icon={p.icon} name={p.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{p.name}</h2>
                      <span className="font-mono text-xs text-zinc-400">{p.version}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {upd?.updateAvailable && <Badge tone="indigo">Update available</Badge>}
                    </div>
                    {p.description && <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{p.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {p.source ? (
                        <a href={`https://github.com/${p.source.repo}/tree/${p.source.commit}/${p.source.path}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200">
                          <GitBranch className="size-3.5" />
                          {p.source.repo}
                          {p.source.path && `/${p.source.path}`}
                          <span className="font-mono">@{p.source.ref ?? p.source.commit.slice(0, 7)}</span>
                        </a>
                      ) : (
                        <span>Built in</span>
                      )}
                      {p.overridesBuiltin && <span>Replaces the built-in version</span>}
                      {p.dependencies.length > 0 && (
                        <span className="flex items-center gap-1">
                          Uses
                          {p.dependencies.map((d) => (
                            <code key={d} className={cx('rounded bg-zinc-100 px-1 font-mono text-[11px] dark:bg-zinc-800', byId.get(d)?.status !== 'active' && 'text-rose-600 dark:text-rose-400')}>
                              {d}
                            </code>
                          ))}
                        </span>
                      )}
                      {p.services.length > 0 && <span>Provides {p.services.map((s) => s.name).join(', ')}</span>}
                    </div>
                    {p.error && p.status !== 'disabled' && (
                      <Alert tone={p.status === 'blocked' ? 'amber' : 'red'} className="mt-3 font-mono text-xs">
                        {p.error}
                      </Alert>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {busy === p.id && <Spinner className="mr-1" />}
                    {p.hasSettings && (
                      <Button size="sm" icon={<Settings2 className="size-3.5" />} onClick={() => setSettings(p)}>
                        Settings
                      </Button>
                    )}
                    <Switch
                      label={p.enabled ? 'Disable' : 'Enable'}
                      checked={p.enabled}
                      disabled={busy === p.id}
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
                        <IconButton label="Actions" {...t}>
                          <MoreHorizontal className="size-4" />
                        </IconButton>
                      )}
                      items={[
                        {
                          label: upd?.updateAvailable ? 'Update now' : 'Update',
                          icon: <ArrowUpCircle />,
                          hidden: !p.source,
                          onSelect: () =>
                            run(p.id, async () => {
                              const r = await api(`/admin/plugins/${p.id}/update`, { method: 'POST' });
                              setUpdates((u) => ({ ...u, [p.id]: { ...u[p.id], updateAvailable: false } }));
                              toast(r.from === r.to ? `${p.name} is up to date` : `${p.name} updated to ${r.plugin.version}`);
                            }),
                        },
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
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <InstallDialog
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={(list) => {
          setInstallOpen(false);
          plugins.reload();
          toast(`Installed ${list.map((p) => p.name).join(', ')}`);
        }}
      />
      <SettingsDialog plugin={settings} onClose={() => setSettings(null)} onSaved={() => { setSettings(null); plugins.reload(); toast('Settings saved'); }} />
      <LogDialog plugin={logs} onClose={() => setLogs(null)} />
    </>
  );
}

function InstallDialog({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (p: PluginInfo[]) => void }) {
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setRepo('');
      setRef('');
      setPath('');
      setError('');
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onInstalled(await api<PluginInfo[]>('/admin/plugins/install', { body: { repo, ref, path } }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Install from GitHub">
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Repository" htmlFor="repo" description="owner/repo or a github.com URL, also to a folder in it. Every plugin.json found at the top level or in plugins/ is installed.">
          <Input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" autoFocus required spellCheck={false} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Branch, tag or commit" htmlFor="ref" optional>
            <Input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Default branch" spellCheck={false} />
          </FormField>
          <FormField label="Folder" htmlFor="path" optional>
            <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/" spellCheck={false} />
          </FormField>
        </div>
        <Alert tone="amber">Plugins run inside Switchboard and can read every credential it stores. Only install plugins you trust.</Alert>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Install
          </Button>
        </div>
      </form>
    </Dialog>
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
