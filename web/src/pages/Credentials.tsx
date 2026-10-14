import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Credential, type Connection, type Service } from '../api';
import { ago, useResource } from '../lib';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, PageHeader, Select, Spinner, useConfirm, useToast } from '../components/ui';
import { FieldsForm } from '../components/forms';
import { ConnectDialog } from './Connections';
import { CredentialPicker, type CredentialCandidate } from '../components/CredentialPicker';

export function Credentials() {
  const credentials = useResource(() => api<Credential[]>('/credentials'));
  const connections = useResource(() => api<Connection[]>('/connections'));
  const services = useResource(() => api<Service[]>('/services'));
  const [params] = useSearchParams();
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<CredentialCandidate | null>(null);
  const [renaming, setRenaming] = useState<Credential | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [rotation, setRotation] = useState<Credential | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consentCredentialId, setConsentCredentialId] = useState<string>();
  const [reconnect, setReconnect] = useState<Connection | null>(null);
  const toast = useToast(); const confirm = useConfirm();
  const connection = connections.data?.find(connection => connection.id === selected);
  useEffect(() => { if (params.get('connection')) setSelected(params.get('connection')!); }, [params]);
  useEffect(() => {
    const id = params.get('credential');
    const credential = credentials.data?.find(credential => credential.id === id);
    if (credential?.kind === 'static') void openRotation(credential);
  }, [credentials.data, params.get('credential')]);
  const openRotation = async (credential: Credential) => {
    setError(''); setValues({});
    try { setRotation(await api<Credential>(`/credentials/${credential.id}`)); } catch (error: any) { setError(error.message); }
  };
  const refresh = () => { credentials.reload(); connections.reload(); };
  const manage = async () => {
    if (!connection) return;
    setBusy(true); setError('');
    try {
      if (choice?.needsConsent) {
        let id = choice.id;
        if (choice.kind === 'connection') id = (await api<{ id: string }>('/credentials', { body: { connection: choice.id, name: name.trim() || `${choice.name} credentials` } })).id;
        setConsentCredentialId(id); setReconnect(connection); return;
      }
      if (choice) await api(`/connections/${connection.id}/credential`, { body: choice.kind === 'connection' ? { sourceConnection: choice.id, name: name.trim() || `${choice.name} credentials` } : { credentialId: choice.id } });
      else await api('/credentials', { body: { connection: connection.id, name } });
      refresh(); toast('Credentials linked'); setChoice(null);
    } catch (error: any) { setError(error.message); }
    finally { setBusy(false); }
  };
  const revoke = async (credential: Credential) => {
    if (!await confirm({ title: `Revoke ${credential.name}?`, message: `Stops authentication for: ${credential.connections.map(connection => connection.name).join(', ') || 'no linked connections'}.`, confirm: 'Revoke', danger: true })) return;
    try { const result = await api<{ providerRevocation: string }>(`/credentials/${credential.id}/revoke`, { body: { version: credential.version } }); refresh(); if (result.providerRevocation === 'failed') toast('Disabled locally; provider revocation failed', 'error'); else if (result.providerRevocation === 'unsupported') toast('Disabled in Switchboard; revoke the token at the provider separately'); }
    catch (error: any) { setError(error.message); }
  };
  return <>
    <PageHeader title="Credentials" />
    {error && <Alert>{error}</Alert>}
    <Card className="mb-5 space-y-3 p-4">
      <h2 className="text-sm font-semibold">Reuse credentials from an existing connection</h2>
      <FormField label="Connection" htmlFor="credential-connection"><Select id="credential-connection" value={selected} onChange={event => { setSelected(event.target.value); setChoice(null); }}><option value="">Select a connection</option>{connections.data?.filter(connection => !connection.readOnly && connection.reusable && !connection.credential).map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</Select></FormField>
      {connection && !connection.credential && <>
        <CredentialPicker connection={connection.id} service={connection.serviceId} method={connection.methodId} config={connection.config} value={choice} onChange={setChoice} />
        <FormField label={choice?.kind === 'credential' ? 'Credential name' : 'New credential name'} htmlFor="credential-name"><Input id="credential-name" value={name} disabled={choice?.kind === 'credential'} onChange={event => setName(event.target.value)} placeholder={choice?.kind === 'connection' ? `${choice.name} credentials` : 'Work account'} /></FormField>
        <p className="text-xs text-zinc-500">{choice ? `Link ${connection.name} to ${choice.name}.` : `Move ${connection.name}'s stored credentials into a reusable credential.`} Secrets remain on the server.</p>
        <Button variant="primary" loading={busy} disabled={!choice && !name.trim()} onClick={manage}>{choice ? 'Link credentials' : 'Create reusable credential'}</Button>
      </>}
    </Card>
    {credentials.loading && !credentials.data && <Spinner />}
    <div className="space-y-3">{credentials.data?.map(credential => <Card key={credential.id} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{credential.name}</h2><Badge>{credential.kind === 'static' ? 'Secret' : 'OAuth account'}</Badge><Badge tone={credential.status === 'ok' ? 'green' : 'red'}>{credential.status === 'ok' ? 'Ready' : credential.status === 'revoked' ? 'Disabled' : credential.status}</Badge></div>
      <p className="text-xs text-zinc-500">Updated {ago(credential.updatedAt)}</p>
      {credential.statusMessage && <p className="text-xs text-rose-600 dark:text-rose-400">{credential.statusMessage}</p>}
      {credential.account && <p className="text-xs text-zinc-500">{credential.account.label}</p>}
      <ul className="space-y-1 text-sm">{credential.connections.map(connection => <li key={connection.id}>{connection.name} · {connection.serviceId}{connection.status !== 'ok' && <span className="text-rose-600"> · {connection.statusMessage ?? connection.status}</span>}</li>)}</ul>
      {!credential.connections.length && <p className="text-xs text-zinc-500">No linked connections. This credential is retained until you delete it.</p>}
      <div className="flex flex-wrap gap-2">
        {credential.kind === 'static' ? <Button size="sm" onClick={() => openRotation(credential)}>Rotate</Button> : <Button size="sm" disabled={!credential.connections.length} onClick={() => { setConsentCredentialId(undefined); setReconnect(connections.data?.find(connection => connection.id === credential.connections[0].id) ?? null); }}>Reconnect</Button>}
        <Button size="sm" onClick={() => { setRenaming(credential); setRenameValue(credential.name); }}>Rename</Button>
        <Button size="sm" onClick={() => revoke(credential)}>Revoke</Button>
        <Button size="sm" disabled={!!credential.connections.length} onClick={async () => { try { await api(`/credentials/${credential.id}`, { method: 'DELETE' }); refresh(); } catch (error: any) { setError(error.message); } }}>Delete</Button>
      </div>
    </Card>)}</div>
    <Dialog open={!!renaming} onClose={() => setRenaming(null)} title="Rename credential"><div className="space-y-3"><FormField label="Name" htmlFor="credential-rename"><Input id="credential-rename" value={renameValue} onChange={event => setRenameValue(event.target.value)} /></FormField><Button onClick={async () => { if (!renaming) return; try { await api(`/credentials/${renaming.id}`, { method: 'PATCH', body: { name: renameValue, version: renaming.version } }); setRenaming(null); refresh(); } catch (error: any) { setError(error.message); } }}>Save</Button></div></Dialog>
    <Dialog open={!!rotation} onClose={() => setRotation(null)} title={`Rotate ${rotation?.name ?? ''}`}>
      <div className="space-y-4"><p className="text-sm">Updates: {rotation?.connections.map(connection => connection.name).join(', ')}.</p>
        {rotation?.fields && <FieldsForm fields={rotation.fields.map(field => ({ ...field, required: false }))} values={values} onChange={setValues} idPrefix="credential-rotate" />}
        {error && <Alert>{error}</Alert>}
        <Button variant="primary" loading={busy} onClick={async () => { if (!rotation) return; setBusy(true); setError(''); try { const result = await api<{ health: { status: string }[] }>(`/credentials/${rotation.id}/rotate`, { body: { version: rotation.version, config: values } }); setRotation(null); refresh(); toast(result.health.some(connection => connection.status !== 'ok') ? 'Rotated; some connections need attention' : 'Credential rotated'); } catch (error: any) { setError(error.message); } finally { setBusy(false); } }}>Rotate for all connections</Button>
      </div>
    </Dialog>
    {reconnect && <ConnectDialog open onClose={() => setReconnect(null)} initial={{ credentialId: consentCredentialId, connection: reconnect, service: services.data?.find(service => service.id === reconnect.serviceId) }} services={services.data ?? []} onConnected={() => { setReconnect(null); refresh(); }} />}
  </>;
}
