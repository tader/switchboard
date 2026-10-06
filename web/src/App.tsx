import { Suspense, lazy, useEffect, useState } from 'react';

// The guides need a Markdown renderer and syntax highlighting; load them only when opened.
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })));
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { api, type Info, type User, unauthorized } from './api';
import { SessionCtx } from './auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Invite } from './pages/Invite';
import { Connections } from './pages/Connections';
import { Console } from './pages/Console';
import { Tokens } from './pages/Tokens';
import { Plugins } from './pages/Plugins';
import { Users } from './pages/Users';
import { Authorize } from './pages/Authorize';
import { Activity } from './pages/Activity';


export function App() {
  const [user, setUser] = useState<User | null | undefined>();
  const [info, setInfo] = useState<Info>({ publicUrl: location.origin, callbackUrl: `${location.origin}/oauth/callback` });
  const loc = useLocation();

  useEffect(() => {
    api<User>('/me').then(setUser, () => setUser(null));
    api<Info>('/info').then(setInfo, () => {});
    const off = () => setUser(null);
    unauthorized.addEventListener('401', off);
    return () => unauthorized.removeEventListener('401', off);
  }, []);

  if (loc.pathname === '/invite') return <Invite onDone={setUser} />;
  if (user === undefined) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!user) return <Login onDone={setUser} />;

  const admin = user.role === 'admin';
  if (loc.pathname === '/oauth/authorize') {
    return (
      <SessionCtx.Provider value={{ user, info, setUser }}>
        <Authorize />
      </SessionCtx.Provider>
    );
  }
  return (
    <SessionCtx.Provider value={{ user, info, setUser }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/connections" replace />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/console" element={<Console />} />
          <Route path="/activity" element={<Activity />} />
          <Route
            path="/docs/*"
            element={
              <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="size-5" /></div>}>
                <Docs />
              </Suspense>
            }
          />
          <Route path="/tokens" element={<Tokens />} />
          {admin && <Route path="/admin/plugins" element={<Plugins />} />}
          {admin && <Route path="/admin/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/connections" replace />} />
        </Routes>
      </Layout>
    </SessionCtx.Provider>
  );
}
