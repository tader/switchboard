import { useState } from 'react';
import { api, type User } from '../api';
import { Logo } from '../components/Logo';
import { Alert, Button, FormField, Input, SecretInput } from '../components/ui';

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm animate-pop">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="mb-5 size-10" />
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">{children}</div>
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await api<User>('/auth/login', { body: { username, password } }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Sign in to Hub">
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Username" htmlFor="username">
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </FormField>
        <FormField label="Password" htmlFor="password">
          <SecretInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
