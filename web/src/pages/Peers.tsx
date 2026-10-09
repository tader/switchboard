import { useEffect, useState } from 'react';
import { KeyRound, MoreHorizontal, MonitorUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type AdminUser, type Peer } from '../api';
import { useSession } from '../auth';
import { ago, useResource } from '../lib';
import { Alert, Badge, Button, Card, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Select, Spinner, Switch, useConfirm, useToast } from '../components/ui';

export function Peers() {
  const { info } = useSession(); const toast = useToast(); const confirm = useConfirm();
  const peers = useResource(() => api<Peer[]>('/admin/peers'));
  const users = useResource(() => api<AdminUser[]>('/admin/users'));
  const [editing, setEditing] = useState<Peer | 'new' | null>(null);
  const [name, setName] = useState(''); const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [url, setUrl] = useState(''); const [credential, setCredential] = useState(''); const [saving, setSaving] = useState(false);
  const [token, setToken] = useState<{ peer: Peer; token: string } | null>(null);
  useEffect(() => { const timer = setInterval(peers.reload, 10_000); return () => clearInterval(timer); }, []);
  const open = (peer: Peer | 'new') => { setEditing(peer); setName(peer === 'new' ? '' : peer.name); setDirection(peer === 'new' ? 'incoming' : peer.direction); setUrl(peer === 'new' ? '' : peer.url ?? ''); setCredential(''); };
  const close = () => { setEditing(null); setCredential(''); };
  const save = async () => {
    if (!editing) return; setSaving(true);
    try {
      const body = { name, ...(editing === 'new' ? { direction } : {}), ...(direction === 'outgoing' ? { url, ...(credential ? { token: credential } : {}) } : {}) };
      const result = await api<any>(editing === 'new' ? '/admin/peers' : `/admin/peers/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body });
      if (result.token) setToken(result); close(); peers.reload();
    } catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const patch = async (peer: Peer, body: Partial<Peer>) => {
    try { await api(`/admin/peers/${peer.id}`, { method: 'PATCH', body }); peers.reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const rotate = async (peer: Peer) => {
    if (!await confirm({ title: `Rotate credentials for ${peer.name}?`, message: 'The current session closes. Update the saved token on the other machine.', confirm: 'Rotate' })) return;
    try { const result = await api<{ token: string }>(`/admin/peers/${peer.id}/rotate-token`, { method: 'POST' }); setToken({ peer, token: result.token }); peers.reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const remove = async (peer: Peer) => {
    if (!await confirm({ title: `Remove ${peer.name}?`, message: 'Stops sharing in both directions. Received connections become unavailable; saved calls and local connections remain.', confirm: 'Remove', danger: true })) return;
    try { await api(`/admin/peers/${peer.id}`, { method: 'DELETE' }); peers.reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return <>
    <PageHeader title="Peers" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('new')}>Add peer</Button>} />
    {peers.loading && !peers.data ? <Spinner /> : peers.error ? <Alert>{peers.error.message}</Alert> : <Card><ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {peers.data?.map(peer => <li key={peer.id} className="flex items-start gap-3 p-4">
        <MonitorUp className="mt-1 size-5 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{peer.name}</span><Badge tone={peer.online ? 'green' : peer.disabled ? 'neutral' : 'amber'}>{peer.state}</Badge></div>
          <div className="mt-1 break-words text-xs text-zinc-500">{peer.direction === 'outgoing' ? `Outgoing · ${peer.url}` : 'Incoming'} · {peer.sharedConnections} sent · {peer.connections.length} received</div>
          {peer.lastSeenAt && <div className="text-xs text-zinc-500">Last seen {ago(peer.lastSeenAt).toLowerCase()}</div>}
          {peer.lastError && <div className="break-words text-xs text-amber-600">{peer.lastError}</div>}
          <fieldset className="mt-3"><legend className="mb-1 text-xs text-zinc-500">Local users allowed to use received connections</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{users.data?.map(u => <label key={u.id} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={peer.userIds.includes(u.id)} disabled={u.id === peer.ownerUserId} onChange={e => patch(peer, { userIds: e.target.checked ? [...peer.userIds, u.id] : peer.userIds.filter(id => id !== u.id) })} />{u.username}{u.id === peer.ownerUserId && ' (owner)'}</label>)}</div></fieldset>
        </div>
        <Switch checked={!peer.disabled} onChange={enabled => patch(peer, { disabled: !enabled })} aria-label={`Enable ${peer.name}`} />
        <Menu trigger={p => <IconButton label={`Actions for ${peer.name}`} {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
          { label: 'Edit', icon: <Pencil />, onSelect: () => open(peer) },
          { label: 'Rotate credentials', icon: <KeyRound />, hidden: peer.direction !== 'incoming', onSelect: () => rotate(peer) }, 'separator',
          { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => remove(peer) },
        ]} />
      </li>)}
      {!peers.data?.length && <li className="p-8 text-center text-sm text-zinc-500">No peers configured.</li>}
    </ul></Card>}
    <Dialog open={!!editing} onClose={close} title={editing === 'new' ? 'Add peer' : 'Edit peer'}>
      <div className="space-y-4"><FormField label="Name"><Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Home PC" /></FormField>
        {editing === 'new' && <FormField label="Establish connection"><Select value={direction} onChange={e => setDirection(e.target.value as 'incoming' | 'outgoing')}><option value="incoming">Accept a connection from the other machine</option><option value="outgoing">Connect to the other machine</option></Select></FormField>}
        {direction === 'outgoing' && <><FormField label="Peer URL"><Input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://switchboard.example.com" /></FormField><FormField label="Device token" description="Create an incoming peer on the other machine. Leave blank to keep the saved token when editing."><Input type="password" autoComplete="new-password" value={credential} onChange={e => setCredential(e.target.value)} /></FormField></>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button variant="primary" loading={saving} disabled={!name.trim() || (direction === 'outgoing' && (!url.trim() || (editing === 'new' && !credential.trim())))} onClick={save}>Save</Button></div>
      </div>
    </Dialog>
    {token && <Dialog open onClose={() => setToken(null)} title={`Connect ${token.peer.name}`} description="This credential is shown once."><div className="space-y-4"><CopyField multiline value={`Peer URL: ${info.publicUrl}\nDevice token: ${token.token}`} /><p className="text-sm">On the other machine, add an outgoing peer using this URL and token. Both sides can choose what to share in Connections → Sharing.</p><div className="flex justify-end"><Button variant="primary" onClick={() => setToken(null)}>Done</Button></div></div></Dialog>}
  </>;
}
