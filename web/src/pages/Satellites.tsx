import { useEffect, useState } from 'react';
import { KeyRound, MoreHorizontal, MonitorUp, Plus, Trash2 } from 'lucide-react';
import { api, type AdminUser, type Satellite } from '../api';
import { Upstreams } from '../components/Upstreams';
import { useSession } from '../auth';
import { ago, useResource } from '../lib';
import { Alert, Badge, Button, Card, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Spinner, Switch, useConfirm, useToast } from '../components/ui';

export function Satellites() {
  const { info, user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const satellites = useResource(() => api<Satellite[]>('/admin/satellites'));
  const users = useResource(() => api<AdminUser[]>('/admin/users'));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState<{ satellite: Satellite; token: string } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => { satellites.reload(); }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const create = async () => {
    try {
      const result = await api<{ satellite: Satellite; token: string }>('/admin/satellites', { body: { name, ownerUserId: user.id } });
      setAdding(false);
      setName('');
      setToken(result);
      satellites.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const patch = async (s: Satellite, body: Partial<Satellite>) => {
    try {
      await api(`/admin/satellites/${s.id}`, { method: 'PATCH', body });
      satellites.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const rotate = async (s: Satellite) => {
    if (!(await confirm({ title: `Rotate credentials for ${s.name}?`, message: 'Its current connection will close and the satellite must be configured with the new token.', confirm: 'Rotate' }))) return;
    try {
      const r = await api<{ token: string }>(`/admin/satellites/${s.id}/rotate-token`, { method: 'POST' });
      setToken({ satellite: s, token: r.token });
      satellites.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const remove = async (s: Satellite) => {
    if (!(await confirm({ title: `Delete ${s.name}?`, message: 'The machine will be disconnected. Shared connections become unavailable; its local connections are preserved.', confirm: 'Delete', danger: true }))) return;
    try {
      await api(`/admin/satellites/${s.id}`, { method: 'DELETE' });
      satellites.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  return <>
    <PageHeader title="Satellites" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add satellite</Button>} />
    <Upstreams />
    <h2 className="mb-3 font-semibold">Downstream satellites</h2>
    {satellites.loading && !satellites.data ? <div className="flex justify-center py-20"><Spinner className="size-5" /></div> : satellites.error ? <Alert>{satellites.error.message}</Alert> :
      <Card className="overflow-hidden"><ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {satellites.data?.map((s) => <li key={s.id} className="flex items-center gap-3 px-4 py-3">
          <MonitorUp className="size-5 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><span className="font-medium">{s.name}</span><Badge tone={s.online ? 'green' : s.disabled ? 'neutral' : 'amber'}>{s.disabled ? 'Disabled' : s.online ? 'Online' : 'Offline'}</Badge></div>
            <div className="mt-0.5 text-xs text-zinc-500">{s.connections.length} shared connection{s.connections.length === 1 ? '' : 's'} · {s.lastSeenAt ? `Last seen ${ago(s.lastSeenAt).toLowerCase()}` : 'Never connected'}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {users.data?.map((u) => <label key={u.id} className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={s.userIds.includes(u.id)} disabled={u.id === s.ownerUserId} onChange={(e) => patch(s, { userIds: e.target.checked ? [...s.userIds, u.id] : s.userIds.filter((id) => id !== u.id) })} />{u.username}{u.id === s.ownerUserId ? ' (owner)' : ''}
              </label>)}
            </div>
          </div>
          <Switch checked={!s.disabled} onChange={(enabled) => patch(s, { disabled: !enabled })} aria-label={`Enable ${s.name}`} />
          <Menu trigger={(p) => <IconButton label="Actions" {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: 'Rotate credentials', icon: <KeyRound />, onSelect: () => rotate(s) }, 'separator',
            { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => remove(s) },
          ]} />
        </li>)}
        {!satellites.data?.length && <li className="p-8 text-center text-sm text-zinc-500">No satellites configured.</li>}
      </ul></Card>}
    <Dialog open={adding} onClose={() => setAdding(false)} title="Add satellite">
      <div className="space-y-4"><FormField label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Home PC" /></FormField><div className="flex justify-end gap-2"><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={create}>Create</Button></div></div>
    </Dialog>
    {token && <Dialog open onClose={() => setToken(null)} title={`Connect ${token.satellite.name}`} description="This credential is shown once. Store it only on the satellite.">
      <div className="space-y-4">
        <CopyField multiline value={`Upstream URL: ${info.publicUrl}\nDevice token: ${token.token}`} />
        <p className="text-sm">On the satellite, open Satellites → Add upstream and enter this URL and token. Then choose connections to share from its Connections page.</p>
        <Alert tone="amber">Anyone with this token can connect as this satellite. Do not put it in a tracked file.</Alert>
        <div className="flex justify-end"><Button variant="primary" onClick={() => setToken(null)}>Done</Button></div>
      </div>
    </Dialog>}
  </>;
}
