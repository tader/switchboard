import { useEffect, useState } from 'react';
import { api, type Connection, type SatelliteUpstream } from '../api';
import { Alert, Button, Dialog, Spinner, useToast } from './ui';

export function ConnectionSharing({ connection, onClose }: { connection: Connection; onClose(): void }) {
  const toast = useToast(); const [upstreams, setUpstreams] = useState<SatelliteUpstream[]>([]); const [ids, setIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api<SatelliteUpstream[]>('/upstreams'), api<{ upstreamIds: string[] }>(`/connections/${connection.id}/shares`)]).then(([upstreams, shares]) => { if (live) { setUpstreams(upstreams); setIds(shares.upstreamIds); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [connection.id]);
  const save = async () => {
    setSaving(true); try { await api(`/connections/${connection.id}/shares`, { method: 'PUT', body: { upstreamIds: ids } }); toast('Sharing updated'); onClose(); }
    catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  return <Dialog open onClose={onClose} title={`Share ${connection.name}`} description="Selected upstreams can use this connection. Its credentials and settings stay on this machine.">
    <div className="space-y-4">{loading ? <Spinner /> : error ? <Alert>{error}</Alert> : <>
      {upstreams.map(u => <label key={u.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><input className="mt-1" type="checkbox" checked={ids.includes(u.id)} onChange={e => setIds(e.target.checked ? [...ids, u.id] : ids.filter(id => id !== u.id))} /><span><span className="font-medium">{u.name}</span><span className="block text-xs text-zinc-500">{u.url}{!u.enabled && ' · Disabled'}</span></span></label>)}
      {!upstreams.length && <p className="text-sm text-zinc-500">Ask a local administrator to add an upstream on the Satellites page first.</p>}
      {connection.readOnly && <p className="text-xs text-zinc-500">This re-shares a downstream connection. It remains usable only while each link in the chain permits access.</p>}
    </>}<div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={loading || !!error || saving} onClick={save}>Save sharing</Button></div></div>
  </Dialog>;
}
