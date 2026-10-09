import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, type Connection, type Peer, type Service } from '../api';
import { Alert, Badge, Input, ServiceIcon, Spinner, useToast } from './ui';

type Grant = { connection_id: string; peer_id: string };
type Matrix = { shares: Grant[]; blocked: Grant[] };
export function SharingMatrix({ connections, services }: { connections: Connection[]; services: Service[] }) {
  const toast = useToast(); const [peers, setPeers] = useState<Peer[]>([]); const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState(''); const [filter, setFilter] = useState(''); const [pending, setPending] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const [nextPeers, nextMatrix] = await Promise.all([api<Peer[]>('/peers'), api<Matrix>('/connection-shares')]); if (live) { setPeers(nextPeers); setMatrix(nextMatrix); setError(''); } }
      catch (e: any) { if (live) setError(e.message); }
    };
    void load(); const timer = setInterval(load, 10_000); return () => { live = false; clearInterval(timer); };
  }, []);
  const visiblePeers = useMemo(() => peers.filter(p => p.name.toLowerCase().includes(filter.trim().toLowerCase())), [peers, filter]);
  const toggle = async (connection: Connection, peer: Peer, shared: boolean) => {
    const key = `${connection.id}:${peer.id}`; setPending(p => new Set(p).add(key));
    try {
      const result = await api<{ peerIds: string[] }>(`/connections/${connection.id}/shares/${peer.id}`, { method: 'PUT', body: { shared } });
      setMatrix(m => m && ({ ...m, shares: [...m.shares.filter(g => g.connection_id !== connection.id || g.peer_id !== peer.id), ...(result.peerIds.includes(peer.id) ? [{ connection_id: connection.id, peer_id: peer.id }] : [])] }));
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setPending(p => { const next = new Set(p); next.delete(key); return next; }); }
  };
  if (!matrix && !error) return <Spinner />;
  return <div className="space-y-3">
    {error && <Alert>{error}</Alert>}
    <Input aria-label="Search peers" placeholder="Search peers…" value={filter} onChange={e => setFilter(e.target.value)} className="max-w-sm" />
    {!peers.length ? <p className="text-sm text-zinc-500">No peers configured. <Link to="/admin/peers" className="text-indigo-600">Manage peers</Link></p> : <div role="region" aria-label="Connection sharing matrix" tabIndex={0} className="max-w-full overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="w-full border-collapse text-sm" aria-label="Connection sharing">
        <thead><tr><th scope="col" className="sticky left-0 z-20 w-48 min-w-48 max-w-48 bg-zinc-50 p-3 text-left dark:bg-zinc-900">Connection</th>
          {visiblePeers.map(peer => <th scope="col" key={peer.id} className="min-w-36 bg-zinc-50 p-3 dark:bg-zinc-900"><div className="font-medium">{peer.name}</div><Badge tone={peer.state === 'online' ? 'green' : 'neutral'}>{peer.state}</Badge><div className="mt-1 text-xs font-normal text-zinc-500">{peer.direction}</div></th>)}
        </tr></thead>
        <tbody>{connections.map(c => <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800">
          <th scope="row" className="sticky left-0 z-10 w-48 min-w-48 max-w-48 bg-white p-3 text-left font-normal dark:bg-zinc-950"><div className="flex w-42 items-center gap-2"><ServiceIcon size="sm" name={c.serviceName} icon={services.find(s => s.id === c.serviceId)?.icon ?? c.icon} /><div className="min-w-0"><div className="break-words font-medium">{c.name}</div><div className="text-xs text-zinc-500 [overflow-wrap:anywhere]">{c.serviceName} · {c.peer?.name ?? 'Local'}</div></div></div></th>
          {visiblePeers.map(peer => {
            const checked = !!matrix?.shares.some(g => g.connection_id === c.id && g.peer_id === peer.id);
            const blocked = !!matrix?.blocked.some(g => g.connection_id === c.id && g.peer_id === peer.id);
            const busy = pending.has(`${c.id}:${peer.id}`);
            return <td key={peer.id} className="p-3 text-center" title={blocked ? 'Sharing would create a cycle or this connection is unavailable' : undefined}>
              <input type="checkbox" className="size-4 accent-indigo-600" aria-label={`Share ${c.name} with ${peer.name}`} checked={checked} disabled={busy || (blocked && !checked)} onChange={e => void toggle(c, peer, e.target.checked)} />
              {busy && <span className="sr-only" role="status">Saving</span>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
      {!visiblePeers.length && <p className="p-3 text-sm text-zinc-500">No matching peers.</p>}
    </div>}
  </div>;
}
