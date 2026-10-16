import { ListToolbar, ListFeedback, SortHeader, useList } from '../components/ListControls';
import { useEffect, useState } from 'react';
import { History, Info, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api, type ApiToken, type Connection } from '../api';
import { useSession } from '../auth';
import { Alert, Badge, Button, Card, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Select, Table, useConfirm, useToast } from '../components/ui';
import { ago, useResource } from '../lib';
import { AccessPicker } from '../components/AccessPicker';

export function Tokens() {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const tokens = useResource(() => api<ApiToken[]>('/tokens'));
  const connections = useResource(() => api<Connection[]>('/connections'));
  const [editing, setEditing] = useState<ApiToken | 'new' | null>(null);
  const [created, setCreated] = useState<{ token: ApiToken; secret: string } | null>(null);

  const list = useList('tokens', tokens.data ?? [], {
    search: t => [t.name, t.prefix, t.clientName],
    sorts: { used: t => t.lastUsedAt, name: t => t.name, created: t => t.createdAt, expiry: t => t.expiresAt },
    defaultSort: 'used', defaultOrder: 'desc', filters: { status: '', audience: '', access: '' },
    filter: (t, f) => (!f.status || (t.expiresAt != null && t.expiresAt <= Date.now() ? 'expired' : 'active') === f.status)
      && (!f.audience || (t.audience === 'mcp' ? 'mcp' : 'api') === f.audience) && (!f.access || (t.connectionIds ? 'selected' : 'all') === f.access),
  });
  const revoke = async (t: ApiToken) => {
    if (!(await confirm({ title: `Revoke “${t.name}”?`, message: 'Scripts using this token will stop working immediately.', confirm: 'Revoke', danger: true }))) return;
    try { await api(`/tokens/${t.id}`, { method: 'DELETE' }); } catch (e: any) { toast(e.message, 'error'); return; }
    tokens.setData((d) => d?.filter((x) => x.id !== t.id));
    toast('Token revoked');
  };

  const connName = (id: string) => connections.data?.find((c) => c.id === id)?.name ?? 'removed';

  return (
    <>
      <PageHeader
        title="API tokens"
        actions={
          (tokens.data?.length ?? 0) > 0 && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New token
            </Button>
          )
        }
      />
      <McpBox />
      <div className="space-y-3">
        <ListToolbar list={list} label="tokens" sorts={[{ value: 'used', label: 'Last used' }, { value: 'name', label: 'Name' }, { value: 'created', label: 'Created' }, { value: 'expiry', label: 'Expiry' }]}>
          <Select aria-label="Token status" value={list.state.status} onChange={e => list.set({ status: e.target.value })} className="w-36"><option value="">Any status</option><option value="active">Active</option><option value="expired">Expired</option></Select>
          <Select aria-label="Token type" value={list.state.audience} onChange={e => list.set({ audience: e.target.value })} className="w-36"><option value="">Any type</option><option value="api">API</option><option value="mcp">MCP only</option></Select>
          <Select aria-label="Token access" value={list.state.access} onChange={e => list.set({ access: e.target.value })} className="w-40"><option value="">Any access</option><option value="all">All connections</option><option value="selected">Selected connections</option></Select>
        </ListToolbar>
        <ListFeedback loading={tokens.loading && !tokens.data} error={tokens.error} empty={!list.visible.length} filtered={list.filtered} label="tokens" retry={tokens.reload} reset={list.reset} />
        {!!list.visible.length && <Table label="API tokens"><thead><tr>
          <SortHeader list={list} field="name">Token</SortHeader><th className="w-20">Status</th><th className="hidden w-24 sm:table-cell">Type</th><th className="hidden w-[22%] lg:table-cell">Access</th><SortHeader list={list} field="used" className="w-28">Last used</SortHeader><SortHeader list={list} field="expiry" className="hidden w-28 md:table-cell">Expires</SortHeader><th className="w-11"><span className="sr-only">Actions</span></th>
        </tr></thead><tbody>{list.visible.map(t => {
          const expired = t.expiresAt != null && t.expiresAt <= Date.now();
          return <tr key={t.id}><td><div className="truncate font-medium" title={t.name}>{t.name}</div><code className="text-[11px] text-zinc-500">{t.prefix}…</code><div className="sr-only">Created {new Date(t.createdAt).toLocaleString()}</div></td>
            <td><Badge tone={expired ? 'red' : 'green'}>{expired ? 'Expired' : 'Active'}</Badge></td><td className="hidden sm:table-cell"><Badge tone={t.audience === 'mcp' ? 'indigo' : 'neutral'}>{t.audience === 'mcp' ? 'MCP only' : 'API'}</Badge></td>
            <td className="hidden lg:table-cell"><span className="block truncate text-xs text-zinc-500" title={t.connectionIds?.map(connName).join(', ')}>{t.connectionIds ? t.connectionIds.map(connName).join(', ') || 'No connections' : 'All connections'}</span></td>
            <td className="whitespace-nowrap text-xs tabular-nums text-zinc-500" title={t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : undefined}>{ago(t.lastUsedAt)}</td><td className="hidden text-xs tabular-nums text-zinc-500 md:table-cell" title={t.expiresAt ? new Date(t.expiresAt).toLocaleString() : undefined}>{t.expiresAt ? ago(t.expiresAt) : 'Never'}</td>
            <td><Menu trigger={p => <IconButton label={`Actions for ${t.name}`} {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
              { label: 'Activity', icon: <History />, onSelect: () => navigate(`/activity?client=${t.id}`) }, { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(t) }, 'separator', { label: 'Revoke', icon: <Trash2 />, danger: true, onSelect: () => revoke(t) },
            ]} /></td></tr>;
        })}</tbody></Table>}
        {!tokens.data?.length && !tokens.loading && !tokens.error && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New token</Button>}
      </div>

      <TokenDialog
        token={editing}
        connections={connections.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={(r) => {
          setEditing(null);
          tokens.reload();
          if ('secret' in r) setCreated(r);
        }}
      />
      <CreatedDialog created={created} connections={connections.data ?? []} onClose={() => setCreated(null)} />
    </>
  );
}

function TokenDialog({
  token, connections, onClose, onSaved,
}: { token: ApiToken | 'new' | null; connections: Connection[]; onClose: () => void; onSaved: (r: ApiToken | { token: ApiToken; secret: string }) => void }) {
  const isNew = token === 'new';
  const [name, setName] = useState('');
  const [limited, setLimited] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    setError('');
    if (token === 'new') {
      setName('');
      setLimited(connections.length > 0);
      setSelected([]);
      setExpires('');
    } else {
      setName(token.name);
      setLimited(!!token.connectionIds);
      setSelected(token.connectionIds ?? []);
    }
  }, [token, connections.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const connectionIds = limited ? selected : null;
      const r = isNew
        ? await api('/tokens', { body: { name, connectionIds, expiresInDays: expires ? Number(expires) : null } })
        : await api(`/tokens/${(token as ApiToken).id}`, { method: 'PATCH', body: { name, connectionIds } });
      onSaved(r);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!token} onClose={onClose} title={isNew ? 'New API token' : 'Edit token'}>
      <form onSubmit={submit} className="space-y-5">
        <FormField label="Name" htmlFor="token-name">
          <Input id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. inbox-summarizer" autoFocus required />
        </FormField>
        <AccessPicker connections={connections} limited={limited} setLimited={setLimited} selected={selected} setSelected={setSelected} />
        {isNew && (
          <FormField label="Expires" htmlFor="token-expires">
            <Select id="token-expires" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="">Never</option>
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </Select>
          </FormField>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={limited && !selected.length}>
            {isNew ? 'Create token' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CreatedDialog({ created, connections, onClose }: { created: { token: ApiToken; secret: string } | null; connections: Connection[]; onClose: () => void }) {
  const { info } = useSession();
  if (!created) return null;
  const first = connections.find((c) => !created.token.connectionIds || created.token.connectionIds.includes(c.id));
  return (
    <Dialog open onClose={onClose} title="Token created" description="Copy it now. It will not be shown again." size="lg" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5 text-[13px]">
        <CopyField value={created.secret} />
        <section className="space-y-2">
          <h3 className="font-medium">Using it</h3>
          <p className="text-zinc-500 dark:text-zinc-400">
            Call any connection through <code className="font-mono text-xs">{info.publicUrl}/proxy/&lt;connection&gt;/&lt;path&gt;</code>. Switchboard adds the credentials.
          </p>
          <CopyField
            multiline
            value={`export SWITCHBOARD_TOKEN=${created.secret}\ncurl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" ${info.publicUrl}/proxy/${first?.name ?? '<connection>'}/`}
          />
          <p className="text-zinc-500 dark:text-zinc-400">
            Or list what it can reach: <code className="font-mono text-xs">GET {info.publicUrl}/api/connections</code>
          </p>
        </section>
      </div>
    </Dialog>
  );
}

function McpBox() {
  const { info } = useSession();
  const url = `${info.publicUrl}/mcp`;
  return (
    <Card className="mb-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">MCP server <Link to="/docs/guides/mcp" aria-label="MCP documentation" title="MCP documentation" className="inline-flex size-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-indigo-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"><Info className="size-4" /></Link></h2>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <CopyField value={url} />

      </div>
    </Card>
  );
}
