import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BookOpen, Code2, ExternalLink, FileKey, History, KeyRound, Laptop, LayoutGrid, List, LockKeyhole, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, Search, Server, ShieldCheck, SquareTerminal, Trash2, Unlock } from 'lucide-react';
import { SharingMatrix } from '../components/SharingMatrix';
import { ConnectionSharing } from '../components/ConnectionSharing';
import { api, type Connection, type FlowResult, type Service } from '../api';
import { useSession } from '../auth';
import { FieldsForm, initialValues } from '../components/forms';
import {
  Alert, Avatar, Badge, Button, Card, CopyField, Dialog, Empty, FormField, IconButton, Input, Menu, PageHeader, Select, ServiceIcon, Spinner, Table, useConfirm, useToast,
} from '../components/ui';
import { ago, cx, useResource } from '../lib';

export function Connections() {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const connections = useResource(() => api<Connection[]>('/connections'));
  const services = useResource(() => api<Service[]>('/services'));
  const [connect, setConnect] = useState<{ service?: Service; connection?: Connection } | null>(null);
  const [sharing, setSharing] = useState<Connection | null>(null);
  const [rename, setRename] = useState<Connection | null>(null);
  const [scripts, setScripts] = useState<Connection | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'normal' | 'compact' | 'sharing'>(() => {
    try { const saved = localStorage.getItem('switchboard.connections.view'); return saved === 'compact' || saved === 'sharing' ? saved : 'normal'; }
    catch { return 'normal'; }
  });
  const changeView = (next: 'normal' | 'compact' | 'sharing') => {
    setView(next);
    try { localStorage.setItem('switchboard.connections.view', next); } catch {}
  };
  const [highlight, setHighlight] = useState<string | null>(null);

  // Coming back from an OAuth redirect.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (!connected && !error) return;
    if (error) toast(error, 'error');
    if (connected) setHighlight(connected);
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  useEffect(() => {
    if (!highlight || !connections.data) return;
    const c = connections.data.find((x) => x.id === highlight);
    if (c) toast(<>Connected <b>{c.account?.label ?? c.name}</b></>);
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight, connections.data, toast]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (connections.data ?? []).filter(c => !q || `${c.name} ${c.serviceName} ${c.account?.label ?? ''} ${c.peer?.name ?? ''}`.toLowerCase().includes(q));
  }, [connections.data, filter]);

  const byService = useMemo(() => {
    const groups = new Map<string, Connection[]>();
    for (const c of visible) groups.set(c.serviceId, [...(groups.get(c.serviceId) ?? []), c]);
    return [...groups];
  }, [visible]);

  useEffect(() => { const timer = setInterval(connections.reload, 10_000); return () => clearInterval(timer); }, []);

  const serviceById = (id: string) => services.data?.find((s) => s.id === id);

  const remove = async (c: Connection) => {
    const ok = await confirm({
      title: `Disconnect ${c.account?.label ?? c.name}?`,
      message: 'Scripts using this connection will stop working. Saved calls are kept.',
      confirm: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/connections/${c.id}`, { method: 'DELETE' });
      connections.setData((d) => d?.filter((x) => x.id !== c.id));
      toast('Disconnected');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const connectionMenu = (c: Connection, service?: Service) => <Menu trigger={p => <IconButton label={`Actions for ${c.name}`} {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
    { label: 'Open in console', icon: <SquareTerminal />, onSelect: () => navigate(`/console?connection=${c.id}`), disabled: c.status === 'unavailable' },
    { label: 'Activity', icon: <History />, onSelect: () => navigate(`/activity?connection=${c.id}`) },
    { label: 'Use from scripts', icon: <Code2 />, onSelect: () => setScripts(c) },
    { label: 'Share with peers', icon: <Server />, onSelect: () => setSharing(c) },
    { label: 'Rename', icon: <Pencil />, onSelect: () => setRename(c), hidden: c.readOnly },
    { label: 'Reconnect', icon: <RefreshCw />, onSelect: () => setConnect({ service, connection: c }), hidden: !service || c.readOnly },
    'separator',
    { label: 'Disconnect', icon: <Trash2 />, onSelect: () => remove(c), danger: true, hidden: c.readOnly },
  ]} />;

  const hasPeers = connections.data?.some(c => c.peer) ?? false;
  const loading = connections.loading && !connections.data;

  return (
    <>
      {sharing && <ConnectionSharing connection={sharing} onClose={() => setSharing(null)} />}
      <PageHeader
        title="Connections"
        actions={
          (connections.data?.length ?? 0) > 0 && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setConnect({})}>
              Connect
            </Button>
          )
        }
      />
      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : connections.error ? (
        <Alert>{connections.error.message}</Alert>
      ) : (connections.data?.length ?? 0) === 0 ? (
        <div className="space-y-6">
          <Empty icon={<Plug className="size-5" />} title="Connect your first account">
            Sign in once here, then use the account from any script with a Switchboard token.
          </Empty>
          {services.data && <ServiceGrid services={services.data} onPick={(s) => setConnect({ service: s })} />}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:flex">
            <Input aria-label="Search connections" placeholder="Search connections…" value={filter} onChange={e => setFilter(e.target.value)} className="min-w-0 flex-1 sm:max-w-sm" />
            <span className="shrink-0 text-xs text-zinc-500">{visible.length} of {connections.data?.length}</span>
            <div role="group" aria-label="Connection view" className="col-span-2 flex shrink-0 justify-self-end gap-0.5 rounded-lg bg-zinc-100 p-0.5 sm:ml-auto dark:bg-zinc-800">
              {([{ value: 'normal', label: 'Normal', Icon: LayoutGrid }, { value: 'compact', label: 'Compact', Icon: List }, { value: 'sharing', label: 'Sharing', Icon: Server }] as const).map(({ value, label, Icon }) => <button key={value} type="button" aria-pressed={view === value} onClick={() => changeView(value)} className={cx('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-500', view === value ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}><Icon className="size-3.5" aria-hidden="true" />{label}</button>)}
            </div>
          </div>
          {view === 'sharing' ? <SharingMatrix connections={visible} services={services.data ?? []} /> : view === 'compact' ? <Table label="Connections">
            <thead><tr>
              <th scope="col" className="w-14 sm:w-[22%]">Service</th>
              <th scope="col">Connection</th>
              {hasPeers && <th scope="col" className="hidden w-[18%] lg:table-cell">Location</th>}
              <th scope="col" className="w-8 sm:w-28">Status</th>
              <th scope="col" className="hidden w-28 md:table-cell">Last used</th>
              <th scope="col" className="w-11"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>{visible.map(c => {
              const service = serviceById(c.serviceId);
              const status = c.status === 'ok' ? 'Connected' : c.status === 'error' ? 'Error' : 'Unavailable';
              const location = c.peer?.name ?? 'Local';
              const LocationIcon = c.peer ? Laptop : Server;
              return <tr key={c.id} className={cx(highlight === c.id && 'bg-indigo-50/70 dark:bg-indigo-500/10')}>
                <td><div className="flex min-w-0 items-center gap-2.5" title={c.serviceName}>
                  <ServiceIcon icon={c.icon ?? service?.icon} name={c.serviceName} size="sm" />
                  <span className="hidden truncate text-zinc-600 sm:block dark:text-zinc-300">{c.serviceName}</span>
                  <span className="sr-only sm:hidden">{c.serviceName}</span>
                </div></td>
                <td>
                  <div className="flex min-w-0 items-center gap-2">
                    <Link to={`/console?connection=${c.id}`} className="truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400" title={c.name}>{c.name}</Link>
                    <AuthIndicator connection={c} service={service} />
                  </div>
                  {c.account?.label && c.account.label !== c.name && <div className="mt-0.5 truncate text-xs text-zinc-500" title={c.account.label}>{c.account.label}</div>}
                  {c.peer && <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 lg:hidden" title={`Peer: ${location}`}><Laptop className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{location}</span></div>}
                  {c.status !== 'ok' && c.statusMessage && <div className="mt-0.5 truncate text-xs text-rose-600 dark:text-rose-400" title={c.statusMessage}>{c.statusMessage}</div>}
                </td>
                {hasPeers && <td className="hidden lg:table-cell"><div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500" title={c.peer ? `Peer: ${location}${c.peer.online ? '' : ' (offline)'}` : location}><LocationIcon className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{location}</span></div></td>}
                <td><span className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400" title={[status, c.statusMessage].filter(Boolean).join(' · ')}>
                  <span className={cx('size-1.5 shrink-0 rounded-full', c.status === 'ok' ? 'bg-emerald-500' : c.status === 'error' ? 'bg-rose-500' : 'bg-amber-500')} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{status}</span>
                </span></td>
                <td className="hidden whitespace-nowrap text-xs tabular-nums text-zinc-500 md:table-cell" title={c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : undefined}>{c.lastUsedAt ? ago(c.lastUsedAt) : 'Never'}</td>
                <td>{connectionMenu(c, service)}</td>
              </tr>;
            })}</tbody>
          </Table> : <div className="space-y-5">{byService.map(([serviceId, list]) => {
            const service = serviceById(serviceId);
            return <Card key={serviceId} className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <ServiceIcon icon={list[0].icon ?? service?.icon} name={list[0].serviceName} size="sm" />
                <h2 className="flex-1 text-[13px] font-semibold">{list[0].serviceName}</h2>
                {service && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setConnect({ service })}>Add account</Button>}
              </div>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{list.map(c => <li key={c.id} className={cx('flex items-center gap-3 px-4 py-3 transition-colors', highlight === c.id && 'bg-indigo-50/70 dark:bg-indigo-500/10')}>
                <Avatar src={c.account?.avatarUrl} label={c.account?.label ?? c.name} className="size-8" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Link to={`/console?connection=${c.id}`} className="truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400">{c.account?.label ?? c.name}</Link>
                    <code className="max-w-full truncate rounded bg-zinc-100 px-1.5 py-px font-mono text-[11.5px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{c.name}</code>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="inline-flex min-w-0 max-w-[45%] items-center gap-1 shrink-0" title={c.peer ? `Peer: ${c.peer.name}${c.peer.online ? '' : ' (offline)'}` : 'Local'}>
                      {c.peer ? <Laptop className="size-3 shrink-0" aria-hidden="true" /> : <Server className="size-3 shrink-0" aria-hidden="true" />}
                      <span className="truncate">{c.peer?.name ?? 'Local'}</span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate" title={c.status === 'ok' ? `${c.methodName} · ${c.lastUsedAt ? `Used ${ago(c.lastUsedAt).toLowerCase()}` : 'Not used yet'}` : c.statusMessage ?? undefined}>{c.status === 'ok' ? `${c.methodName} · ${c.lastUsedAt ? `Used ${ago(c.lastUsedAt).toLowerCase()}` : 'Not used yet'}` : <span className="text-rose-600 dark:text-rose-400">{c.statusMessage}</span>}</span>
                  </div>
                </div>
                {c.status === 'error' && service && <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => setConnect({ service, connection: c })}>Reconnect</Button>}
                {c.status === 'unavailable' && <Badge tone="amber">Unavailable</Badge>}
                {connectionMenu(c, service)}
              </li>)}</ul>
            </Card>;
          })}</div>}
          {!visible.length && <p className="py-6 text-center text-zinc-500">No connections match your search.</p>}
        </div>
      )}

      <ConnectDialog
        open={!!connect}
        services={services.data ?? []}
        initial={connect ?? {}}
        onClose={() => setConnect(null)}
        onConnected={(c) => {
          setConnect(null);
          connections.reload();
          setHighlight(c.id);
        }}
      />
      <RenameDialog
        connection={rename}
        onClose={() => setRename(null)}
        onDone={(c) => {
          connections.setData((d) => d?.map((x) => (x.id === c.id ? c : x)));
          setRename(null);
        }}
      />
      <ScriptsDialog connection={scripts} onClose={() => setScripts(null)} />
    </>
  );
}

function AuthIndicator({ connection: c, service }: { connection: Connection; service?: Service }) {
  const method = service?.methods.find(m => m.id === c.methodId);
  const name = `${c.methodId} ${c.methodName}`.toLowerCase();
  const Icon = method?.redirect || /oauth|device|client.credentials/.test(name) ? ShieldCheck
    : /service.account/.test(name) ? FileKey
    : /basic|password/.test(name) ? LockKeyhole
    : /token|api.key|header|query|bearer/.test(name) ? KeyRound
    : /none|no auth|unauthenticated/.test(name) ? Unlock
    : /command|shell/.test(name) ? SquareTerminal : Plug;
  return <span tabIndex={0} role="img" aria-label={`Sign-in: ${c.methodName}`} title={`Sign-in: ${c.methodName}`} className="shrink-0 rounded text-zinc-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-zinc-500"><Icon className="size-3.5" aria-hidden="true" /></span>;
}

function ServiceGrid({ services, onPick, filter = '' }: { services: Service[]; onPick: (s: Service) => void; filter?: string }) {
  const q = filter.trim().toLowerCase();
  const list = services.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q) || s.id.includes(q));
  if (!list.length) return <p className="py-8 text-center text-[13px] text-zinc-500">{filter ? `No services match “${filter}”.` : 'No services are available on this Switchboard.'}</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {list.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s)}
          className="flex items-center gap-3 rounded-xl bg-white p-3 text-left ring-1 ring-zinc-200 transition hover:ring-indigo-300 hover:shadow-sm dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:ring-indigo-500/50"
        >
          <ServiceIcon icon={s.icon} name={s.name} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{s.name}</span>
            {s.description && <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{s.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

type Step =
  | { kind: 'pick' }
  | { kind: 'form' }
  | { kind: 'device'; flowId: string; device: Extract<FlowResult, { status: 'device' }>['device'] }
  | { kind: 'paste'; flowId: string; url: string; redirectUri: string };

export function ConnectDialog({
  open, onClose, services, initial, onConnected,
}: { open: boolean; onClose: () => void; services: Service[]; initial: { service?: Service; connection?: Connection }; onConnected: (c: Connection) => void }) {
  const { info } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [service, setService] = useState<Service | undefined>();
  const [methodId, setMethodId] = useState<string>('');
  const [values, setValues] = useState<Record<string, any>>({});
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('local');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reconnecting = initial.connection;
  const targets = useMemo(() => {
    const peers = new Map<string, { id: string; name: string; online: boolean }>();
    for (const s of services) if (s.peer) peers.set(s.peer.id, s.peer);
    return [{ id: 'local', name: 'Local', online: true }, ...[...peers.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }, [services]);
  const targetServices = services.filter((s) => target === 'local' ? !s.peer : s.peer?.id === target);

  const choose = (s: Service, preferMethod?: string, config?: Record<string, any>) => {
    setService(s);
    const m = s.methods.find((x) => x.id === preferMethod) ?? s.methods.find((x) => !x.unavailable) ?? s.methods[0];
    setMethodId(m.id);
    setValues({ ...initialValues(m.fields, config), __redirectUri: m.id === initial.connection?.methodId ? initial.connection?.redirectUri ?? '' : '' });
    setError('');
    setStep({ kind: 'form' });
  };

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setTarget(initial.service?.peer?.id ?? initial.connection?.peer?.id ?? 'local');
    setError('');
    setBusy(false);
    if (initial.service) choose(initial.service, initial.connection?.methodId, initial.connection?.config);
    else {
      setService(undefined);
      setStep({ kind: 'pick' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const method = service?.methods.find((m) => m.id === methodId);

  const handle = (r: FlowResult, redirectUri?: string) => {
    if (r.status === 'connected') onConnected(r.connection);
    else if (r.status === 'redirect' && r.manual) setStep({ kind: 'paste', flowId: r.flowId, url: r.url, redirectUri: redirectUri ?? '' });
    else if (r.status === 'redirect') location.href = r.url;
    else setStep({ kind: 'device', flowId: r.flowId, device: r.device });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!service || !method) return;
    setBusy(true);
    setError('');
    const { __name, __redirectUri, ...config } = values;
    try {
      const body = { service: service.id, method: method.id, config, name: __name || undefined, redirectUri: method.redirect ? __redirectUri || undefined : undefined };
      const r = reconnecting
        ? await api<FlowResult>(`/connections/${reconnecting.id}/reconnect`, { body })
        : await api<FlowResult>('/connections', { body });
      handle(r, __redirectUri);
      if (r.status !== 'redirect' || r.manual) setBusy(false);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  // Device flow polling
  useEffect(() => {
    if (step.kind !== 'device' || !open) return;
    let stopped = false;
    let delay = Math.max(1, step.device.interval) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<FlowResult | { status: 'pending'; interval?: number }>(`/connect/${step.flowId}/poll`, { method: 'POST' });
        if (stopped) return;
        if (r.status === 'pending') {
          if (r.interval) delay = r.interval * 1000;
          timer = setTimeout(poll, delay);
        } else handle(r as FlowResult);
      } catch (err: any) {
        if (!stopped) {
          setError(err.message);
          setStep({ kind: 'form' });
        }
      }
    };
    timer = setTimeout(poll, delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open]);

  const close = () => {
    if (step.kind === 'device' || step.kind === 'paste') api(`/connect/${step.flowId}`, { method: 'DELETE' }).catch(() => {});
    onClose();
  };

  const fields = method
    ? [
        ...method.fields,
        ...(reconnecting
          ? []
          : [{ key: '__name', label: 'Name', advanced: true, placeholder: 'Generated from the account', description: 'How scripts refer to this connection.' }]),
        ...(method.redirect
          ? [
              {
                key: '__redirectUri',
                label: 'Redirect URI',
                type: 'url' as const,
                advanced: true,
                placeholder: info.callbackUrl,
                description: 'Only if the provider has a different redirect URI registered, such as http://localhost:8080/callback. After signing in, you paste the address you are sent to.',
              },
            ]
          : []),
      ]
    : [];

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title={
        step.kind === 'pick' ? (
          'Connect an account'
        ) : (
          <span className="flex items-center gap-2.5">
            {service && <ServiceIcon icon={service.icon} name={service.name} size="sm" />}
            {reconnecting ? `Reconnect ${reconnecting.account?.label ?? reconnecting.name}` : `Connect ${service?.name}`}
          </span>
        )
      }
    >
      {step.kind === 'pick' && (
        <div className="space-y-3">
          {targets.length > 1 && <FormField label="Switchboard" htmlFor="connection-target">
            <Select id="connection-target" value={target} onChange={(e) => { setTarget(e.target.value); setSearch(''); }}>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (offline)'}</option>)}
            </Select>
          </FormField>}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <Input autoFocus placeholder="Search services" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <ServiceGrid services={targetServices} filter={search} onPick={(s) => choose(s)} />
        </div>
      )}

      {step.kind === 'form' && service && (
        <form onSubmit={submit} className="space-y-5">
          {service.methods.length > 1 && (
            <div role="radiogroup" aria-label="Sign-in method" className="grid gap-2">
              {service.methods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === methodId}
                  disabled={!!m.unavailable}
                  onClick={() => {
                    setMethodId(m.id);
                    setValues({ ...initialValues(m.fields, m.id === reconnecting?.methodId ? reconnecting.config : undefined), __redirectUri: m.id === reconnecting?.methodId ? reconnecting.redirectUri ?? '' : '' });
                    setError('');
                  }}
                  className={cx(
                    'flex items-start gap-3 rounded-xl px-3.5 py-2.5 text-left ring-1 transition',
                    m.id === methodId
                      ? 'bg-indigo-50/60 ring-2 ring-indigo-500 dark:bg-indigo-500/10 dark:ring-indigo-400'
                      : 'ring-zinc-200 hover:ring-zinc-300 disabled:hover:ring-zinc-200 dark:ring-zinc-800 dark:hover:ring-zinc-700',
                    m.unavailable && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span
                    className={cx(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1',
                      m.id === methodId ? 'bg-indigo-600 ring-indigo-600' : 'ring-zinc-300 dark:ring-zinc-600',
                    )}
                  >
                    {m.id === methodId && <span className="size-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{m.name}</span>
                    {(m.unavailable || m.description) && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{m.unavailable ?? m.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          {service.methods.length === 1 && method?.unavailable && <Alert tone="amber">{method.unavailable}</Alert>}
          {service.guides.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <BookOpen className="size-4 text-zinc-400" />
              {service.guides.map((g) => (
                <a key={g.id} href={`/docs/${g.id}`} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  {g.title}
                </a>
              ))}
            </div>
          )}
          {method && fields.length > 0 && <FieldsForm key={method.id} fields={fields} values={values} onChange={setValues} idPrefix={`${service.id}-${method.id}`} />}
          {error && <Alert>{error}</Alert>}
          <div className="flex items-center justify-between gap-2 pt-1">
            {!initial.service ? (
              <Button variant="ghost" onClick={() => setStep({ kind: 'pick' })}>
                Back
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" loading={busy} disabled={!method || !!method.unavailable}>
              Continue
            </Button>
          </div>
        </form>
      )}

      {step.kind === 'paste' && <PasteStep step={step} onConnected={onConnected} onRestart={() => setStep({ kind: 'form' })} />}

      {step.kind === 'device' && (
        <div className="space-y-5 py-2 text-center">
          <p className="text-[13px] text-zinc-600 dark:text-zinc-300">Enter this code on the sign-in page:</p>
          <div className="flex items-center justify-center gap-2">
            <code className="rounded-xl bg-zinc-100 px-5 py-3 font-mono text-2xl font-semibold tracking-[0.2em] dark:bg-zinc-800">{step.device.userCode}</code>
          </div>
          <div className="flex justify-center gap-2">
            <Button
              variant="primary"
              icon={<ExternalLink className="size-4" />}
              onClick={() => {
                navigator.clipboard?.writeText(step.device.userCode).catch(() => {});
                window.open(step.device.verificationUriComplete ?? step.device.verificationUri, '_blank', 'noopener');
              }}
            >
              Copy code and open {safeHost(step.device.verificationUri)}
            </Button>
          </div>
          <p className="flex items-center justify-center gap-2 text-xs text-zinc-500">
            <Spinner className="size-3.5" />
            Waiting for approval…
          </p>
        </div>
      )}
    </Dialog>
  );
}

function PasteStep({ step, onConnected, onRestart }: { step: Extract<Step, { kind: 'paste' }>; onConnected: (c: Connection) => void; onRestart: () => void }) {
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = safeHost(step.redirectUri);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ connection: Connection }>(`/connect/${step.flowId}/complete`, { body: { url: pasted } });
      onConnected(r.connection);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-5">
      <ol className="space-y-4 text-[13px] text-zinc-600 dark:text-zinc-300">
        <li className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">1</span>
          <div className="space-y-2">
            <p>Sign in on the provider’s page.</p>
            <Button
              size="sm"
              variant={opened ? 'secondary' : 'primary'}
              icon={<ExternalLink className="size-3.5" />}
              onClick={() => {
                window.open(step.url, '_blank', 'noopener');
                setOpened(true);
              }}
            >
              {opened ? 'Open the sign-in page again' : 'Open the sign-in page'}
            </Button>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">2</span>
          <p>
            Afterwards your browser goes to <b className="break-all">{target}</b>. That page will probably not load; that is expected. Copy the whole address from the address bar.
          </p>
        </li>
        <li className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">3</span>
          <div className="min-w-0 flex-1 space-y-2">
            <p>Paste it here:</p>
            <Input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={`${step.redirectUri}?code=…`}
              className="font-mono text-[12.5px]"
              spellCheck={false}
              autoComplete="off"
              aria-label="Address after signing in"
            />
          </div>
        </li>
      </ol>
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onRestart}>
          Back
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!pasted.trim()}>
          Complete sign-in
        </Button>
      </div>
    </form>
  );
}

function safeHost(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return 'sign-in page';
  }
}

function RenameDialog({ connection, onClose, onDone }: { connection: Connection | null; onClose: () => void; onDone: (c: Connection) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (connection) {
      setName(connection.name);
      setError('');
    }
  }, [connection]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await api<Connection>(`/connections/${connection!.id}`, { method: 'PATCH', body: { name } }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!connection} onClose={onClose} title="Rename connection" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Name" htmlFor="conn-name" description="Scripts that use the old name will stop working.">
          <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus spellCheck={false} />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ScriptsDialog({ connection: c, onClose }: { connection: Connection | null; onClose: () => void }) {
  const { info } = useSession();
  if (!c) return null;
  if (c.kind === 'mcp') return <Dialog open onClose={onClose} title="Use from scripts" description={`${c.name} · ${c.serviceName}`} size="lg">
    <div className="space-y-4 text-[13px]">
      <CopyField multiline value={`curl -X POST "${info.publicUrl}/api/connections/${c.id}/mcp/tools/list" -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H "Content-Type: application/json" --data '{}'`} />
      <CopyField multiline value={`curl -X POST "${info.publicUrl}/api/connections/${c.id}/mcp/tools/call" -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H "Content-Type: application/json" --data '{"name":"tool_name","arguments":{}}'`} />
      <Link to="/tokens" onClick={onClose} className="text-indigo-600 dark:text-indigo-400">Create a token limited to this connection</Link>
    </div>
  </Dialog>;
  const proxy = `${info.publicUrl}/proxy/${c.name}`;
  const examplePath = c.serviceId === 'gmail' ? '/gmail/v1/users/me/profile' : c.serviceId === 'github' ? '/user' : '/';
  return (
    <Dialog open onClose={onClose} title="Use from scripts" description={`${c.account?.label ?? c.name} · ${c.serviceName}`} size="lg">
      <div className="space-y-5 text-[13px]">
        <section className="space-y-2">
          <h3 className="font-medium">Through Switchboard</h3>
          <p className="text-zinc-500 dark:text-zinc-400">
            Send requests to the proxy URL with your Switchboard token. Paths are relative to <code className="font-mono text-xs">{c.baseUrl ?? 'the service'}</code>; Switchboard adds the
            credentials.
          </p>
          <CopyField value={proxy} />
          <CopyField multiline value={`curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \\\n  ${proxy}${examplePath}`} />
        </section>
        {c.canIssueToken && (
          <section className="space-y-2">
            <h3 className="font-medium">Access token for an SDK</h3>
            <p className="text-zinc-500 dark:text-zinc-400">Returns a fresh access token. It is refreshed when needed, so ask for a new one instead of storing it.</p>
            <CopyField multiline value={`curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \\\n  ${info.publicUrl}/api/connections/${c.name}/token`} />
          </section>
        )}
        <p className="text-zinc-500 dark:text-zinc-400">
          Need a token?{' '}
          <Link to="/tokens" onClick={onClose} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Create one
          </Link>{' '}
          and limit it to this connection.
        </p>
      </div>
    </Dialog>
  );
}
