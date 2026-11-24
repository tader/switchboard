import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

test('private parent IPC and browser setup/recovery work together without HTTP recovery authority', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-account-integration-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data); fs.mkdirSync(path.join(root, 'plugins'));
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  async function launch(enabled: boolean) {
    const child = fork(path.resolve('server/main.ts'), [], { execArgv: ['--disable-warning=ExperimentalWarning'],
      env: { ...process.env, SWITCHBOARD_DATA_DIR: data, SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_PUBLIC_URL: url,
        SWITCHBOARD_INSTALL_MODE: 'runtime', SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY: enabled ? '1' : '0', SWITCHBOARD_UPDATE_CHECKS: 'false',
        SWITCHBOARD_BUILTIN_PLUGINS_DIR: path.join(root, 'plugins'), SWITCHBOARD_WATCH_PLUGINS: 'false' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
    let sequence = 0;
    child.on('message', (message: any) => {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Error('Private account action rejected')); else request.resolve(message.result);
    });
    const ipc = (action: string, userId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('IPC timeout')); }, 5000);
      pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child.send({ kind: 'local-manager', id, action, userId });
    });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    };
    try {
      const until = Date.now() + 15000;
      while (true) {
        try { if ((await fetch(url + '/readyz', { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
        if (child.exitCode !== null || Date.now() > until) throw Error('Synthetic server readiness failed');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { ipc, stop };
    } catch (error) { await stop(); throw error; }
  }
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(true);
    const first = await running.ipc('bootstrap');
    assert.ok(first.accountCapabilities.includes('account-recovery'));
    const token = new URL(first.setupUrl).hash.slice(1);
    const info = await (await fetch(url + '/api/auth/invite/' + encodeURIComponent(token))).json() as any;
    assert.equal(info.allowUsername, true);
    const post = (route: string, body: unknown, cookie = '') => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, cookie }, body: JSON.stringify(body) });
    const enrollment = await post('/api/auth/invite', { token, username: 'sample-owner', password: 'synthetic-owner-password' });
    assert.equal(enrollment.status, 200);
    const ownerCookie = enrollment.headers.get('set-cookie')!.split(';')[0];
    const created = await post('/api/admin/users', { username: 'sample-member', role: 'user' }, ownerCookie);
    assert.equal(created.status, 201); const member = await created.json() as any;
    const accepted = await post('/api/auth/invite', { token: new URL(member.invite.url).hash.slice(1), password: 'synthetic-member-password' });
    assert.equal(accepted.status, 200); const memberCookie = accepted.headers.get('set-cookie')!.split(';')[0];
    const listed = await running.ipc('account-users');
    assert.equal(listed.users.length, 2);
    const recovery = await running.ipc('account-recovery', member.user.id);
    const recoveryToken = new URL(recovery.setupUrl).hash.slice(1);
    const metadata = await (await fetch(url + '/api/auth/invite/' + encodeURIComponent(recoveryToken))).json() as any;
    assert.equal(metadata.allowUsername, false);
    assert.equal((await fetch(url + '/api/me', { headers: { cookie: memberCookie } })).status, 200);
    assert.equal((await post('/api/auth/invite', { token: recoveryToken, password: 'synthetic-recovered-password' })).status, 200);
    assert.equal((await fetch(url + '/api/me', { headers: { cookie: memberCookie } })).status, 401);
    assert.equal((await post('/api/auth/login', { username: 'sample-member', password: 'synthetic-recovered-password' })).status, 200);
    assert.equal((await post('/api/auth/invite', { token: recoveryToken, password: 'synthetic-reused-password' })).status, 400);
    const pairing = await running.ipc('pair');
    assert.equal((await fetch(url + '/api/me', { headers: { authorization: `Bearer ${pairing.token}` } })).status, 401);
    assert.equal((await post('/api/auth/recovery', { userId: member.user.id }, ownerCookie)).status, 404);
    await running.stop();
    running = await launch(false);
    assert.deepEqual((await running.ipc('bootstrap')).accountCapabilities, []);
    await assert.rejects(running.ipc('account-users'));
    await assert.rejects(running.ipc('account-recovery', member.user.id));
  } finally { await running?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
