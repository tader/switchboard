import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { BookOpen, ChevronsUpDown, History, KeyRound, LogOut, Menu as MenuIcon, MonitorUp, Moon, Plug, Puzzle, SquareTerminal, Sun, UserRound, Users, X } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../auth';
import { cx } from '../lib';
import { Logo } from './Logo';
import { Avatar, Button, Dialog, FormField, Menu, SecretInput, Alert, useToast } from './ui';

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors [&>svg]:size-4',
          isActive
            ? 'bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200 dark:bg-zinc-800/80 dark:text-white dark:ring-zinc-700/60'
            : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {}
    setDark(next);
  };
  return { dark, toggle };
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, setUser } = useSession();
  const { dark, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const fullBleed = loc.pathname === '/console';

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-3">
      <div className="flex items-center gap-2.5 px-1.5 pt-1">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Switchboard</span>
      </div>
      <nav className="flex flex-col gap-0.5">
        <NavItem to="/connections" icon={<Plug />}>
          Connections
        </NavItem>
        <NavItem to="/console" icon={<SquareTerminal />}>
          Console
        </NavItem>
        <NavItem to="/activity" icon={<History />}>
          Activity
        </NavItem>
        <NavItem to="/tokens" icon={<KeyRound />}>
          API tokens
        </NavItem>
      </nav>
      {user.role === 'admin' && (
        <nav className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Admin</div>
          <NavItem to="/admin/plugins" icon={<Puzzle />}>
            Plugins
          </NavItem>
          <NavItem to="/admin/users" icon={<Users />}>
            Users
          </NavItem>
          <NavItem to="/admin/satellites" icon={<MonitorUp />}>
            Satellites
          </NavItem>
        </nav>
      )}
      <nav className="mt-auto flex flex-col gap-0.5">
        <NavItem to="/docs" icon={<BookOpen />}>
          Docs
        </NavItem>
      </nav>
      <div>
        <Menu
          align="start"
          footer={<>Version {import.meta.env.VITE_APP_VERSION}</>}
          trigger={(p) => (
            <button {...p} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50">
              <Avatar label={user.username} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{user.username}</span>
                <span className="block text-[11px] text-zinc-500">{user.role === 'admin' ? 'Administrator' : 'Member'}</span>
              </span>
              <ChevronsUpDown className="size-4 text-zinc-400" />
            </button>
          )}
          items={[
            { label: 'Change password', icon: <UserRound />, onSelect: () => setPasswordOpen(true) },
            { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? <Sun /> : <Moon />, onSelect: toggle },
            'separator',
            {
              label: 'Sign out',
              icon: <LogOut />,
              onSelect: async () => {
                await api('/auth/logout', { method: 'POST' }).catch(() => {});
                setUser(null);
              },
            },
          ]}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-56 shrink-0 border-r border-zinc-200 bg-zinc-100/60 md:block dark:border-zinc-800/80 dark:bg-zinc-900/40">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 animate-in bg-zinc-950/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 animate-pop bg-zinc-50 shadow-xl dark:bg-zinc-900">
            <button className="absolute right-3 top-4 text-zinc-500" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5 md:hidden dark:border-zinc-800">
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="text-zinc-600 dark:text-zinc-300">
            <MenuIcon className="size-5" />
          </button>
          <Logo className="size-6" />
          <span className="font-semibold">Switchboard</span>
        </header>
        <main className={cx('min-h-0 flex-1', fullBleed ? 'overflow-hidden' : 'scrollbar-thin overflow-y-auto')}>
          {fullBleed ? children : <div className={cx('mx-auto px-4 py-8 sm:px-8', loc.pathname === '/activity' ? 'max-w-7xl' : loc.pathname.startsWith('/docs') ? 'max-w-6xl' : 'max-w-5xl')}>{children}</div>}
        </main>
      </div>
      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setCurrent('');
      setPassword('');
      setError('');
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/me/password', { method: 'PUT', body: { current, password } });
      toast('Password changed. Other sessions were signed out.');
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Change password" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Current password" htmlFor="pw-current">
          <SecretInput id="pw-current" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
        </FormField>
        <FormField label="New password" htmlFor="pw-new" description="At least 8 characters">
          <SecretInput id="pw-new" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
