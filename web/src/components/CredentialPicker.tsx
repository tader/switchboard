import { useEffect, useState } from 'react';
import { api } from '../api';
import { FormField, Select } from './ui';
export interface CredentialCandidate { id: string; name: string; kind: 'connection' | 'credential'; needsConsent: boolean; status: string }
export function CredentialPicker({ connection, service, method, config, value, onChange }: { connection?: string; service: string; method: string; config: Record<string, any>; value: CredentialCandidate | null; onChange(value: CredentialCandidate | null): void }) {
  const [choices, setChoices] = useState<CredentialCandidate[]>([]);
  // Credential compatibility is determined server-side; no credential material is returned.
  const key = JSON.stringify(config);
  useEffect(() => {
    const controller = new AbortController();
    api<CredentialCandidate[]>('/credentials/candidates', { body: { connection, service, method, config }, signal: controller.signal }).then(setChoices).catch(() => setChoices([]));
    return () => controller.abort();
  }, [connection, service, method, key]);
  const id = `credential-source-${connection ?? service}-${method}`;
  return <FormField label="Credentials" htmlFor={id}><Select id={id} value={value ? `${value.kind}:${value.id}` : ''} onChange={event => onChange(choices.find(choice => `${choice.kind}:${choice.id}` === event.target.value) ?? null)}>
    <option value="">Enter new credentials</option>
    {choices.map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.kind === 'connection' ? 'Use from ' : ''}{choice.name}{choice.needsConsent ? ' · additional consent required' : ''}</option>)}
  </Select></FormField>;
}
