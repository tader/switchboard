import { ListToolbar, ListFeedback, SortHeader, useList, useViewState } from '../components/ListControls';
import { SharingMatrix, onSharingChanged } from '../components/SharingMatrix';
import { useEffect, useState } from 'react';
import { KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type AdminUser, type Connection, type Peer, type PeerSummary } from '../api';
import { useSession } from '../auth';
import { ago, useResource } from '../lib';
import { Alert, Badge, Button, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Select, Switch, Table, Tabs, Checkbox, useConfirm, useToast } from '../components/ui';

export function Peers() {
  const { info, user } = useSession();
  const admin = user.role === 'admin'; const toast = useToast(); const confirm = useConfirm();
  const peers = useResource(() => api<PeerSummary[]>('/peers'));
  const adminPeers = useResource(() => admin ? api<Peer[]>('/admin/peers') : Promise.resolve([]));
  const connections = useResource(() => api<Connection[]>('/connections'));
  const [view, setView] = useViewState('peers-navigation', { tab: 'overview', peer: '', detail: 'shared' }, ['peer', 'detail']);
  const selected = peers.data?.find(peer => peer.id === view.peer);
  const selectedAdmin = adminPeers.data?.find(peer => peer.id === view.peer);
  const reload = () => { peers.reload(); adminPeers.reload(); };
  const list = useList('peers', peers.data ?? [], { search: p => [p.name, p.url], sorts: { name: p => p.name, state: p => p.state, seen: p => p.lastSeenAt, sent: p => p.sharedConnections, received: p => p.receivedConnections }, filters: { status: '', direction: '' }, filter: (p, f) => (!f.status || p.state === f.status) && (!f.direction || p.direction === f.direction) });
  const users = useResource(() => admin ? api<AdminUser[]>('/admin/users') : Promise.resolve([]));
  const [editing, setEditing] = useState<Peer | 'new' | null>(null);
  const [name, setName] = useState(''); const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [url, setUrl] = useState(''); const [credential, setCredential] = useState(''); const [saving, setSaving] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [token, setToken] = useState<{ peer: Peer; token: string } | null>(null);
  useEffect(() => { const timer = setInterval(reload, 10_000); const off = onSharingChanged(reload); return () => { clearInterval(timer); off(); }; }, []);
  const open = (peer: Peer | 'new') => { setEditing(peer); setName(peer === 'new' ? '' : peer.name); setDirection(peer === 'new' ? 'incoming' : peer.direction); setUrl(peer === 'new' ? '' : peer.url ?? ''); setCredential(''); };
  const close = () => { setEditing(null); setCredential(''); };
  const save = async () => {
    if (!editing) return; setSaving(true);
    try {
      const body = { name, ...(editing === 'new' ? { direction } : {}), ...(direction === 'outgoing' ? { url, ...(credential ? { token: credential } : {}) } : {}) };
      const result = await api<any>(editing === 'new' ? '/admin/peers' : `/admin/peers/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body });
      if (result.token) setToken(result); close(); reload();
    } catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const patch = async (peer: Peer, body: Partial<Peer>) => {
    try { await api(`/admin/peers/${peer.id}`, { method: 'PATCH', body }); await Promise.all([peers.reload(), adminPeers.reload()]); } catch (e: any) { toast(e.message, 'error'); }
  };
  const rotate = async (peer: Peer) => {
    if (!await confirm({ title: `Rotate credentials for ${peer.name}?`, message: 'The current session closes. Update the saved token on the other machine.', confirm: 'Rotate' })) return;
    try { const result = await api<{ token: string }>(`/admin/peers/${peer.id}/rotate-token`, { method: 'POST' }); setToken({ peer, token: result.token }); reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const remove = async (peer: Peer) => {
    if (!await confirm({ title: `Remove ${peer.name}?`, message: 'Stops sharing in both directions. Received connections become unavailable; saved calls and local connections remain.', confirm: 'Remove', danger: true })) return;
    try { await api(`/admin/peers/${peer.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return <>
    <PageHeader title="Peers" actions={admin && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('new')}>Add peer</Button>} />
    <Tabs value={view.tab === 'sharing' ? 'sharing' : 'overview'} onChange={tab => setView({ tab })} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'sharing', label: 'Sharing' }]} className="mb-4" />
    {view.tab === 'sharing' ? <>
      <ListFeedback loading={connections.loading && !connections.data} error={connections.error} empty={false} label="connections" retry={connections.reload} reset={() => {}} />
      {connections.data && <SharingMatrix connections={connections.data} />}
    </> : <div className="space-y-3">
      <ListToolbar list={list} label="peers" sorts={[{ value: 'name', label: 'Name' }, { value: 'state', label: 'Status' }, { value: 'seen', label: 'Last seen' }, { value: 'sent', label: 'Shared by you' }, { value: 'received', label: 'Received' }]}>
        <Select aria-label="Peer status" value={list.state.status} onChange={e => list.set({ status: e.target.value })} className="w-36"><option value="">Any status</option>{['online', 'offline', 'connecting', 'disabled'].map(state => <option key={state} value={state}>{state.charAt(0).toUpperCase() + state.slice(1)}</option>)}</Select>
        <Select aria-label="Peer direction" value={list.state.direction} onChange={e => list.set({ direction: e.target.value })} className="w-36"><option value="">Any direction</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></Select>
      </ListToolbar>
      <ListFeedback loading={peers.loading && !peers.data} error={peers.error} empty={!list.visible.length} filtered={list.filtered} label="peers" retry={peers.reload} reset={list.reset} />
      {!!list.visible.length && <Table label="Peers"><thead><tr><SortHeader list={list} field="name">Peer</SortHeader><SortHeader list={list} field="state" className="w-24">Status</SortHeader><th className="hidden w-24 md:table-cell">Direction</th><SortHeader list={list} field="sent" className="w-28">Shared by you</SortHeader><SortHeader list={list} field="received" className="hidden w-24 sm:table-cell">Received</SortHeader><SortHeader list={list} field="seen" className="hidden w-28 lg:table-cell">Last seen</SortHeader>{admin && <th className="w-20"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>{list.visible.map(peer => {
          const managed = adminPeers.data?.find(p => p.id === peer.id);
          return <tr key={peer.id}><td><button className="block max-w-full truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400" onClick={() => setView({ peer: peer.id, detail: 'shared' })}>{peer.name}</button><div className="truncate text-xs text-zinc-500" title={peer.url ?? undefined}>{peer.url}</div></td>
            <td><Badge tone={peer.state === 'online' ? 'green' : peer.state === 'disabled' ? 'neutral' : 'amber'}>{peer.state}</Badge></td><td className="hidden text-xs capitalize text-zinc-500 md:table-cell">{peer.direction}</td>
            <td><button className="text-indigo-600 tabular-nums hover:underline dark:text-indigo-400" aria-label={`Manage sharing with ${peer.name}`} onClick={() => setView({ peer: peer.id, detail: 'shared' })}>{peer.sharedConnections}</button></td><td className="hidden tabular-nums sm:table-cell"><button aria-label={`Connections received from ${peer.name}`} className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setView({ peer: peer.id, detail: 'received' })}>{peer.receivedConnections}</button></td>
            <td className="hidden text-xs text-zinc-500 lg:table-cell" title={peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleString() : undefined}>{ago(peer.lastSeenAt)}</td>
            {admin && <td>{managed && <div className="flex items-center justify-end"><Switch checked={!peer.disabled} onChange={enabled => patch(managed, { disabled: !enabled })} label={`Enable ${peer.name}`} /><Menu trigger={p => <IconButton label={`Actions for ${peer.name}`} {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
              { label: 'Edit', icon: <Pencil />, onSelect: () => open(managed) }, { label: 'Local user access', onSelect: () => setView({ peer: peer.id, detail: 'access' }) },
              { label: 'Rotate credentials', icon: <KeyRound />, hidden: peer.direction !== 'incoming', onSelect: () => rotate(managed) }, 'separator', { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => remove(managed) },
            ]} /></div>}</td>}
          </tr>;
        })}</tbody>
      </Table>}
      {adminPeers.error && <Alert>{adminPeers.error.message}<Button variant="ghost" size="sm" onClick={adminPeers.reload}>Try again</Button></Alert>}
    </div>}
    <Dialog open={!!selected} onClose={() => setView({ peer: '' })} title={selected?.name ?? 'Peer'} size="xl" footer={<Button onClick={() => setView({ peer: '' })}>Done</Button>}>
      {selected && <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><Badge tone={selected.state === 'online' ? 'green' : 'neutral'}>{selected.state}</Badge><span className="text-xs text-zinc-500">{selected.direction} · Last seen {ago(selected.lastSeenAt).toLowerCase()}</span></div>
        {selectedAdmin?.lastError && <Alert tone="amber">{selectedAdmin.lastError}</Alert>}
        <Tabs value={view.detail === 'received' || (admin && view.detail === 'access') ? view.detail : 'shared'} onChange={detail => setView({ detail })} tabs={[{ value: 'shared', label: 'Shared by you' }, { value: 'received', label: 'Received' }, ...(admin ? [{ value: 'access', label: 'Access' }] : [])]} />
        {view.detail === 'received' ? <ReceivedConnections connections={(connections.data ?? []).filter(c => c.peer?.id === selected.id)} loading={connections.loading && !connections.data} error={connections.error} retry={connections.reload} /> : view.detail === 'access' && admin ? <>
          <p className="text-[13px] text-zinc-500">Local users allowed to use received connections</p>
          <ListFeedback error={users.error ?? adminPeers.error} loading={users.loading || adminPeers.loading} empty={false} label="users" retry={() => { users.reload(); adminPeers.reload(); }} reset={() => {}} />
          {selectedAdmin && users.data?.map(u => <label key={u.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><Checkbox checked={selectedAdmin.userIds.includes(u.id)} disabled={accessSaving || u.id === selectedAdmin.ownerUserId} onChange={async value => { setAccessSaving(true); try { await patch(selectedAdmin, { userIds: value ? [...selectedAdmin.userIds, u.id] : selectedAdmin.userIds.filter(id => id !== u.id) }); } finally { setAccessSaving(false); } }} />{u.username}{u.id === selectedAdmin.ownerUserId && <Badge>Owner</Badge>}</label>)}
        </> : <><ListFeedback loading={connections.loading && !connections.data} error={connections.error} empty={false} label="connections" retry={connections.reload} reset={() => {}} />{connections.data && <SharingMatrix connections={connections.data} peerId={selected.id} />}</>}
      </div>}
    </Dialog>
    <Dialog open={!!editing} onClose={close} title={editing === 'new' ? 'Add peer' : 'Edit peer'}>
      <div className="space-y-4"><FormField label="Name"><Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Home PC" /></FormField>
        {editing === 'new' && <FormField label="Establish connection"><Select value={direction} onChange={e => setDirection(e.target.value as 'incoming' | 'outgoing')}><option value="incoming">Accept a connection from the other machine</option><option value="outgoing">Connect to the other machine</option></Select></FormField>}
        {direction === 'outgoing' && <><FormField label="Peer URL"><Input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://switchboard.example.com" /></FormField><FormField label="Device token" description="Create an incoming peer on the other machine. Leave blank to keep the saved token when editing."><Input type="password" autoComplete="new-password" value={credential} onChange={e => setCredential(e.target.value)} /></FormField></>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button variant="primary" loading={saving} disabled={!name.trim() || (direction === 'outgoing' && (!url.trim() || (editing === 'new' && !credential.trim())))} onClick={save}>Save</Button></div>
      </div>
    </Dialog>
    {token && <Dialog open onClose={() => setToken(null)} title={`Connect ${token.peer.name}`} description="This credential is shown once."><div className="space-y-4"><CopyField multiline value={`Peer URL: ${info.publicUrl}\nDevice token: ${token.token}`} /><p className="text-sm">On the other machine, add an outgoing peer using this URL and token. Both sides can choose what to share in Peers → Sharing.</p><div className="flex justify-end"><Button variant="primary" onClick={() => setToken(null)}>Done</Button></div></div></Dialog>}
  </>;
}

function ReceivedConnections({ connections, loading, error, retry }: { connections: Connection[]; loading: boolean; error?: Error; retry(): void }) {
  const list = useList('peer-received', connections, { search: c => [c.name, c.serviceName], sorts: { name: c => c.name, service: c => c.serviceName, status: c => c.status }, filters: { status: '' }, filter: (c, f) => !f.status || c.status === f.status });
  return <div className="space-y-3"><ListToolbar list={list} label="received connections" sorts={[{ value: 'name', label: 'Name' }, { value: 'service', label: 'Service' }, { value: 'status', label: 'Status' }]}><Select aria-label="Received connection status" value={list.state.status} onChange={e => list.set({ status: e.target.value })} className="w-36"><option value="">Any status</option><option value="ok">Connected</option><option value="error">Error</option><option value="unavailable">Unavailable</option></Select></ListToolbar><ListFeedback loading={loading} error={error} empty={!list.visible.length} filtered={list.filtered} label="received connections" retry={retry} reset={list.reset} />{!!list.visible.length && <Table label="Received connections"><thead><tr><SortHeader list={list} field="name">Connection</SortHeader><SortHeader list={list} field="service">Service</SortHeader><SortHeader list={list} field="status" className="w-28">Status</SortHeader></tr></thead><tbody>{list.visible.map(c => <tr key={c.id}><td className="truncate font-medium">{c.name}</td><td className="truncate text-zinc-500">{c.serviceName}</td><td><Badge tone={c.status === 'ok' ? 'green' : 'amber'}>{c.status === 'ok' ? 'Connected' : c.status === 'error' ? 'Error' : 'Unavailable'}</Badge></td></tr>)}</tbody></Table>}</div>;
}
