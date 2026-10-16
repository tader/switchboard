import { useEffect, useState } from 'react';
import { api, type PeerSummary } from '../api';
import { useResource } from '../lib';
import { Alert, Checkbox, useToast } from './ui';
import { onSharingChanged } from './SharingMatrix';

export function AuthenticationSharing({ connection }: { connection: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const data = useResource(async () => {
    const [shares, peers] = await Promise.all([api<{peerIds:string[];credentialPeerIds:string[]}>(`/connections/${connection}/shares`), api<PeerSummary[]>('/peers')]);
    return { ...shares, peers };
  });
  useEffect(() => onSharingChanged(data.reload), []);
  const change = async (peer: string, enabled: boolean) => {
    if (!data.data || busy) return;
    setBusy(true);
    try {
      await api(`/connections/${connection}/shares`, { method: 'PUT', body: { peerIds: data.data.peerIds, credentialPeerIds: enabled ? [...data.data.credentialPeerIds, peer] : data.data.credentialPeerIds.filter(id => id !== peer) } });
      data.reload();
    } catch (error: any) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  };
  return <div className="mt-5 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
    <p className="text-sm font-medium">Share authentication</p>
    <p className="text-xs text-zinc-500">Selected peers may store refresh credentials and call the provider directly while this device is offline. Stopping sharing blocks future transfers and linked use once received; it cannot recall credentials from an offline peer.</p>
    {data.error && <Alert>Authentication sharing could not be loaded.</Alert>}
    {data.data?.peers.filter(peer => data.data!.peerIds.includes(peer.id)).map(peer => <label key={peer.id} className="flex items-center gap-2 text-sm"><Checkbox disabled={busy} checked={data.data!.credentialPeerIds.includes(peer.id)} onChange={value => change(peer.id, value)} />Allow authentication on {peer.name}</label>)}
    {data.data && !data.data.peerIds.length && <p className="text-xs text-zinc-500">Share the connection with a peer above before enabling authentication.</p>}
  </div>;
}
