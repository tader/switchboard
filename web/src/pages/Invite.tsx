import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type User } from '../api';
import { Alert, Button, FormField, Input, SecretInput, Spinner } from '../components/ui';
import { AuthCard } from './Login';

export function Invite({ onDone }: { onDone: (u: User) => void }) {
  const token = location.hash.slice(1);
  const navigate = useNavigate();
  const [invite, setInvite] = useState<{ username: string; hasPassword: boolean } | null>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/auth/invite/${encodeURIComponent(token)}`).then(setInvite, () => setInvite(null));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords do not match');
    setBusy(true);
    setError('');
    try {
      const user = await api<User>('/auth/invite', { body: { token, password } });
      history.replaceState(null, '', '/');
      onDone(user);
      navigate('/connections', { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (invite === undefined) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (invite === null) {
    return (
      <AuthCard title="This link has expired" subtitle="Ask an administrator for a new one.">
        <Button className="w-full" onClick={() => (location.href = '/')}>
          Go to sign in
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={invite.hasPassword ? 'Choose a new password' : 'Welcome to Switchboard'} subtitle={invite.hasPassword ? undefined : 'Choose a password to finish setting up your account.'}>
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Username" htmlFor="username">
          <Input id="username" value={invite.username} readOnly disabled autoComplete="username" />
        </FormField>
        <FormField label="Password" htmlFor="password" description="At least 8 characters">
          <SecretInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus />
        </FormField>
        <FormField label="Confirm password" htmlFor="confirm">
          <SecretInput id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}
