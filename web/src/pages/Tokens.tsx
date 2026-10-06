import { useEffect, useState } from 'react';
import { History, KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api, type ApiToken, type Connection } from '../api';
import { useSession } from '../auth';
import { Alert, Badge, Button, Card, CopyField, Dialog, Empty, FormField, IconButton, Input, Menu, PageHeader, Select, Spinner, useConfirm, useToast } from '../components/ui';
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

  const revoke = async (t: ApiToken) => {
    if (!(await confirm({ title: `Revoke “${t.name}”?`, message: 'Scripts using this token will stop working immediately.', confirm: 'Revoke', danger: true }))) return;
    await api(`/tokens/${t.id}`, { method: 'DELETE' });
    tokens.setData((d) => d?.filter((x) => x.id !== t.id));
    toast('Token revoked');
  };

  const connName = (id: string) => connections.data?.find((c) => c.id === id)?.name ?? 'removed';

  return (
    <>
      <PageHeader
        title="API tokens"
        description="Scripts and agents use these to call your connections through the hub."
        actions={
          (tokens.data?.length ?? 0) > 0 && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New token
            </Button>
          )
        }
      />
      <McpBox />
      {tokens.loading && !tokens.data ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : !tokens.data?.length ? (
        <Empty
          icon={<KeyRound className="size-5" />}
          title="No tokens yet"
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New token
            </Button>
          }
        >
          Create one token per script or agent, so you can limit and revoke each separately.
        </Empty>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {tokens.data.map((t) => {
              const expired = t.expiresAt && t.expiresAt < Date.now();
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    <KeyRound className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <code className="font-mono text-[11.5px] text-zinc-400">{t.prefix}…</code>
                      {t.audience === 'mcp' && <Badge tone="indigo">MCP only</Badge>}
                      {expired && <Badge tone="red">Expired</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {t.connectionIds ? (
                        t.connectionIds.map((id) => (
                          <code key={id} className="rounded bg-zinc-100 px-1.5 py-px font-mono text-[11px] dark:bg-zinc-800">
                            {connName(id)}
                          </code>
                        ))
                      ) : (
                        <span>All connections</span>
                      )}
                      <span>·</span>
                      <span>{t.lastUsedAt ? `Used ${ago(t.lastUsedAt).toLowerCase()}` : 'Never used'}</span>
                      {t.expiresAt && !expired && (
                        <>
                          <span>·</span>
                          <span>Expires {ago(t.expiresAt).toLowerCase()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Menu
                    trigger={(p) => (
                      <IconButton label="Actions" {...p}>
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                    items={[
                      { label: 'Activity', icon: <History />, onSelect: () => navigate(`/activity?client=${t.id}`) },
                      { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(t) },
                      'separator',
                      { label: 'Revoke', icon: <Trash2 />, danger: true, onSelect: () => revoke(t) },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

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
            Call any connection through <code className="font-mono text-xs">{info.publicUrl}/proxy/&lt;connection&gt;/&lt;path&gt;</code>. The hub adds the credentials.
          </p>
          <CopyField
            multiline
            value={`export HUB_TOKEN=${created.secret}\ncurl -H "Authorization: Bearer $HUB_TOKEN" ${info.publicUrl}/proxy/${first?.name ?? '<connection>'}/`}
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
          <h2 className="text-[13px] font-semibold">MCP server</h2>
          <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            Claude and other AI assistants can use your connections through this URL. They sign in here and you choose which connections to share.
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <CopyField value={url} />
        <details className="text-[13px]">
          <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Setup commands</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-zinc-500">Claude Code, signing in through the browser:</p>
            <CopyField value={`claude mcp add --transport http hub ${url}`} />
            <p className="text-xs text-zinc-500">With a token instead (create one below, limited to the connections it needs):</p>
            <CopyField value={`claude mcp add --transport http hub ${url} --header "Authorization: Bearer $HUB_TOKEN"`} />
            <p className="text-xs text-zinc-500">Claude Desktop and claude.ai: add a custom connector with the URL above.</p>
          </div>
        </details>
        <Link to="/docs/hub/mcp" className="inline-block text-[13px] font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Setup for Claude, Codex, Copilot, OpenCode and others
        </Link>
      </div>
    </Card>
  );
}
