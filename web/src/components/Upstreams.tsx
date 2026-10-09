import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, type SatelliteUpstream } from '../api';
import { ago, useResource } from '../lib';
import { Alert, Badge, Button, Card, Dialog, FormField, IconButton, Input, Spinner, Switch, useConfirm, useToast } from './ui';

export function Upstreams() {
  const upstreams = useResource(() => api<SatelliteUpstream[]>('/admin/upstreams'));
  const toast = useToast(); const confirm = useConfirm();
  const [editing, setEditing] = useState<SatelliteUpstream | 'new' | null>(null);
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [token, setToken] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => { const timer = setInterval(upstreams.reload, 10_000); return () => clearInterval(timer); }, []);
  const open = (u: SatelliteUpstream | 'new') => { setEditing(u); setName(u === 'new' ? '' : u.name); setUrl(u === 'new' ? '' : u.url); setToken(''); };
  const save = async () => {
    if (!editing) return; setSaving(true);
    try { await api(editing === 'new' ? '/admin/upstreams' : `/admin/upstreams/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: { name, url, ...(token ? { token } : {}) } }); setEditing(null); setToken(''); upstreams.reload(); }
    catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const remove = async (u: SatelliteUpstream) => {
    if (!await confirm({ title: `Remove ${u.name}?`, message: 'Stops sharing with this upstream. Local connections remain available.', confirm: 'Remove', danger: true })) return;
    try { await api(`/admin/upstreams/${u.id}`, { method: 'DELETE' }); upstreams.reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return <section className="mb-6 space-y-3">
    <div className="flex items-center justify-between"><h2 className="font-semibold">Upstreams</h2><Button icon={<Plus className="size-4" />} onClick={() => open('new')}>Add upstream</Button></div>
    {upstreams.error && <Alert>{upstreams.error.message}</Alert>}
    {upstreams.loading && !upstreams.data && <Spinner />}
    <Card><ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {upstreams.data?.map(u => <li key={u.id} className="flex items-center gap-3 p-4"><div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="font-medium">{u.name}</span><Badge tone={u.state === 'online' ? 'green' : u.state === 'disabled' ? 'neutral' : 'amber'}>{u.state}</Badge></div>
        <div className="truncate text-xs text-zinc-500">{u.url} · {u.sharedConnections} shared connection{u.sharedConnections === 1 ? '' : 's'}</div>
        <div className="text-xs text-zinc-500">{u.nextRetryAt ? `Retrying ${ago(u.nextRetryAt).toLowerCase()}` : u.lastSeenAt ? `Last connected ${ago(u.lastSeenAt).toLowerCase()}` : ''}{u.lastError && ` · ${u.lastError}`}</div>
      </div><Switch checked={u.enabled} aria-label={`Enable ${u.name}`} onChange={async enabled => { try { await api(`/admin/upstreams/${u.id}`, { method: 'PATCH', body: { enabled } }); upstreams.reload(); } catch (e: any) { toast(e.message, 'error'); } }} />
        <IconButton label={`Edit ${u.name}`} onClick={() => open(u)}><Pencil className="size-4" /></IconButton><IconButton label={`Remove ${u.name}`} onClick={() => remove(u)}><Trash2 className="size-4" /></IconButton></li>)}
      {!upstreams.data?.length && <li className="p-5 text-sm text-zinc-500">No upstreams configured. Nothing is shared.</li>}
    </ul></Card>
    <Dialog open={!!editing} onClose={() => { setEditing(null); setToken(''); }} title={editing === 'new' ? 'Add upstream' : 'Edit upstream'}>
      <div className="space-y-4"><FormField label="Name"><Input autoFocus value={name} onChange={e => setName(e.target.value)} /></FormField>
        <FormField label="Upstream URL"><Input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://switchboard.example.com" /></FormField>
        <FormField label="Device token" description="Create this machine under Satellites on the receiving Switchboard. Leave blank to keep the saved token when editing."><Input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} /></FormField>
        <div className="flex justify-end gap-2"><Button onClick={() => { setEditing(null); setToken(''); }}>Cancel</Button><Button variant="primary" disabled={saving || !name.trim() || !url.trim() || (editing === 'new' && !token.trim())} onClick={save}>Save</Button></div></div>
    </Dialog>
  </section>;
}
