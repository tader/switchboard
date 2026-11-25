import { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Button } from '../components/ui';
export function Certificates() {
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState('');
  const load = () =>
    api<any[]>('/admin/certificates')
      .then(setItems)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Certificates</h1>
      <p className="text-sm text-zinc-500">
        Additional trust for OAuth client metadata only. Each exception applies
        to one host and port.
      </p>
      {error && <Alert>{error}</Alert>}
      {!items.length && <p>No certificate exceptions.</p>}
      {items.map((r) => (
        <section
          key={r.id}
          className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700"
        >
          <h2 className="font-medium break-all">{r.origin}</h2>
          <dl className="space-y-2 text-sm break-all">
            {[
              ['Subject', r.subject],
              ['Issuer', r.issuer],
              ['Expires', r.validTo],
              ['SHA-256', r.fingerprint],
              ['Approved by', r.approved_by_name ?? 'Former administrator'],
              ['Approved', new Date(r.created_at).toLocaleString()],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-zinc-500">{k}</dt>
                <dd className="whitespace-pre-wrap">{v}</dd>
              </div>
            ))}
          </dl>
          <Button
            onClick={async () => {
              try {
                await api('/admin/certificates/' + r.id, { method: 'DELETE' });
                await load();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Remove trust
          </Button>
        </section>
      ))}
    </div>
  );
}
