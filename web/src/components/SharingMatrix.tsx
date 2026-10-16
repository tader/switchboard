import { useEffect, useRef, useState } from 'react';
import { api, type Connection, type PeerSummary, type Service } from '../api';
import { ago, useResource } from '../lib';
import { Alert, Badge, Checkbox, Select, ServiceIcon, Spinner, Table, useToast } from './ui';
import { ListFeedback, ListToolbar, SortHeader, useList } from './ListControls';

type Grant = { connection_id: string; peer_id: string };
type Matrix = { shares: Grant[]; blocked: Grant[] };
const changedEvent = 'switchboard:sharing-changed';
export function onSharingChanged(reload: () => void) {
  window.addEventListener(changedEvent, reload);
  return () => window.removeEventListener(changedEvent, reload);
}

/** The same per-cell mutation and eligibility rules drive the matrix and both scoped editors. */
export function SharingMatrix({ connections, services = [], peerId, connectionId }: { connections: Connection[]; services?: Service[]; peerId?: string; connectionId?: string }) {
  const toast = useToast();
  const data = useResource(async () => {
    const [peers, matrix] = await Promise.all([api<PeerSummary[]>('/peers'), api<Matrix>('/connection-shares')]);
    return { peers, matrix };
  });
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState(new Set<string>());
  useEffect(() => {
    const timer = setInterval(data.reload, 10_000);
    const off = onSharingChanged(data.reload);
    return () => { clearInterval(timer); off(); };
  }, []);
  const matrix = data.data?.matrix;
  const checked = (connection: string, peer: string) => !!matrix?.shares.some(g => g.connection_id === connection && g.peer_id === peer);
  const scope = connectionId ?? peerId ?? 'all';
  const connectionList = useList(`sharing-connections-${scope}`, connections.filter(c => !connectionId || c.id === connectionId), {
    search: c => [c.name, c.serviceName, c.peer?.name], sorts: { name: c => c.name, service: c => c.serviceName, status: c => c.status }, filters: { status: '', sharing: '' },
    filter: (c, f) => (!f.status || c.status === f.status) && (!f.sharing || (peerId ? checked(c.id, peerId) : !!matrix?.shares.some(g => g.connection_id === c.id)) === (f.sharing === 'shared')),
  });
  const peerList = useList(`sharing-peers-${scope}`, (data.data?.peers ?? []).filter(p => !peerId || p.id === peerId), {
    search: p => [p.name, p.url], sorts: { name: p => p.name, state: p => p.state, seen: p => p.lastSeenAt }, filters: { status: '', sharing: '' },
    filter: (p, f) => (!f.status || p.state === f.status) && (!f.sharing || (connectionId ? checked(connectionId, p.id) : !!matrix?.shares.some(g => g.peer_id === p.id)) === (f.sharing === 'shared')),
  });
  const toggle = async (connection: Connection, peer: PeerSummary, shared: boolean) => {
    const key = `${connection.id}:${peer.id}`;
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key); setPending(new Set(pendingRef.current));
    try {
      const result = await api<{ peerIds: string[] }>(`/connections/${connection.id}/shares/${peer.id}`, { method: 'PUT', body: { shared } });
      data.setData(d => d && ({ ...d, matrix: { ...d.matrix, shares: [...d.matrix.shares.filter(g => g.connection_id !== connection.id), ...result.peerIds.map(peer_id => ({ connection_id: connection.id, peer_id }))] } }));
      window.dispatchEvent(new Event(changedEvent));
    } catch (e: any) { toast(e.message, 'error'); }
    finally { pendingRef.current.delete(key); setPending(new Set(pendingRef.current)); }
  };
  const cell = (connection: Connection, peer: PeerSummary) => {
    const selected = checked(connection.id, peer.id);
    const blocked = !!matrix?.blocked.some(g => g.connection_id === connection.id && g.peer_id === peer.id);
    const busy = pending.has(`${connection.id}:${peer.id}`);
    const reason = blocked ? 'Sharing would create a cycle or this connection is unavailable.' : undefined;
    return <span className="inline-flex items-center justify-center gap-2" title={reason}>
      <Checkbox checked={selected} disabled={busy || (blocked && !selected)} onChange={value => void toggle(connection, peer, value)} aria-label={`Share ${connection.name} with ${peer.name}`} />
      {busy && <Spinner className="size-3" />}{blocked && !selected && <span className="sr-only">{reason}</span>}
    </span>;
  };
  if (!data.data) return <ListFeedback loading={data.loading} error={data.error} empty={false} label="shares" retry={data.reload} reset={() => {}} />;
  return <div className="space-y-3">
    {data.error && <Alert>{data.error.message}</Alert>}
    {!connectionId && <ListToolbar list={connectionList} label="connections" sorts={[{ value: 'name', label: 'Name' }, { value: 'service', label: 'Service' }, { value: 'status', label: 'Status' }]}>
      <Select aria-label="Sharing connection status" value={connectionList.state.status} onChange={e => connectionList.set({ status: e.target.value })} className="w-36"><option value="">Any status</option><option value="ok">Connected</option><option value="error">Error</option><option value="unavailable">Unavailable</option></Select>
      <Select aria-label="Connection sharing" value={connectionList.state.sharing} onChange={e => connectionList.set({ sharing: e.target.value })} className="w-36"><option value="">Any sharing</option><option value="shared">Shared</option><option value="unshared">Not shared</option></Select>
    </ListToolbar>}
    {!peerId && <ListToolbar list={peerList} label="peers" sorts={[{ value: 'name', label: 'Name' }, { value: 'state', label: 'Status' }, { value: 'seen', label: 'Last seen' }]}>
      <Select aria-label="Sharing peer status" value={peerList.state.status} onChange={e => peerList.set({ status: e.target.value })} className="w-36"><option value="">Any status</option>{['online', 'offline', 'connecting', 'disabled'].map(state => <option key={state} value={state}>{state.charAt(0).toUpperCase() + state.slice(1)}</option>)}</Select>
      {connectionId && <Select aria-label="Peer sharing" value={peerList.state.sharing} onChange={e => peerList.set({ sharing: e.target.value })} className="w-36"><option value="">Any sharing</option><option value="shared">Shared</option><option value="unshared">Not shared</option></Select>}
    </ListToolbar>}
    <p className="text-xs text-zinc-500" role="status">{pending.size ? 'Saving sharing…' : 'Changes save automatically.'}</p>
    {!connectionList.visible.length || !peerList.visible.length ? <ListFeedback empty filtered={connectionList.filtered || peerList.filtered} label={!connections.length ? 'connections' : 'peers'} retry={data.reload} reset={() => { connectionList.reset(); peerList.reset(); }} /> : connectionId ? <Table label="Sharing with peers"><thead><tr><SortHeader list={peerList} field="name">Peer</SortHeader><SortHeader list={peerList} field="state" className="w-24">Status</SortHeader><th className="hidden w-24 sm:table-cell">Direction</th><SortHeader list={peerList} field="seen" className="hidden w-28 md:table-cell">Last seen</SortHeader><th className="w-20">Shared</th></tr></thead><tbody>{peerList.visible.map(p => <tr key={p.id}><td><div className="truncate font-medium">{p.name}</div><div className="truncate text-xs text-zinc-500">{p.url}</div></td><td><Badge tone={p.state === 'online' ? 'green' : 'neutral'}>{p.state}</Badge></td><td className="hidden text-xs capitalize text-zinc-500 sm:table-cell">{p.direction}</td><td className="hidden text-xs text-zinc-500 md:table-cell">{ago(p.lastSeenAt)}</td><td>{cell(connectionList.visible[0], p)}</td></tr>)}</tbody></Table> : <div role="region" aria-label="Connection sharing matrix" tabIndex={0} className="overflow-auto rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <table className="w-full border-collapse text-left text-[13px]" aria-label="Connection sharing"><thead><tr><SortHeader list={connectionList} field="name" className="sticky left-0 z-20 min-w-52 bg-zinc-50 p-3 font-medium dark:bg-zinc-900">Connection</SortHeader>{peerList.visible.map(p => <th scope="col" key={p.id} className="min-w-32 bg-zinc-50 p-3 text-center font-medium dark:bg-zinc-900"><div>{p.name}</div><Badge tone={p.state === 'online' ? 'green' : 'neutral'}>{p.state}</Badge></th>)}</tr></thead>
        <tbody>{connectionList.visible.map(c => <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800"><th scope="row" className="sticky left-0 z-10 max-w-64 bg-white p-3 font-normal dark:bg-zinc-900"><div className="flex items-center gap-2"><ServiceIcon size="sm" name={c.serviceName} icon={c.icon ?? services.find(s => s.id === c.serviceId)?.icon} /><div className="min-w-0"><div className="truncate font-medium" title={c.name}>{c.name}</div><div className="truncate text-xs text-zinc-500">{c.serviceName} · {c.peer?.name ?? 'Local'}</div></div></div></th>{peerList.visible.map(p => <td key={p.id} className="p-3 text-center">{cell(c, p)}</td>)}</tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
