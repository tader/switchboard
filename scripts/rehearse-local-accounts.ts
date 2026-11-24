/** Synthetic private-supervisor account rehearsal. Usage: node scripts/rehearse-local-accounts.ts /prepared/runtime */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
const runtime = path.resolve(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-accounts-rehearsal-'));
const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
const url = `http://127.0.0.1:${port}`;
const settings = { instance: 'synthetic-accounts', mode: 'runtime', initialRelease: runtime, stateDir: path.join(root, 'updater'), dataDir: path.join(root, 'data'), appUrl: url,
  env: { SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_PUBLIC_URL: url, SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY: '1', SWITCHBOARD_UPDATE_CHECKS: 'false', SWITCHBOARD_WATCH_PLUGINS: 'false' } };
const child = spawn(path.join(runtime, 'bin/node'), ['--disable-warning=ExperimentalWarning', 'updater/desktop.ts'], { cwd: runtime, stdio: ['pipe', 'pipe', 'ignore'] });
const events: any[] = [];
readline.createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
function send(action: string, extra: Record<string, unknown> = {}) { child.stdin.write(JSON.stringify({ action, ...extra }) + '\n'); }
async function wait(event: string, requestId?: string) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const index = events.findIndex(e => e.event === event && (!requestId || e.requestId === requestId));
    if (index >= 0) return events.splice(index, 1)[0];
    if (child.exitCode !== null || events.some(e => e.event === 'error')) throw Error('Synthetic supervisor failed');
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error('Supervisor response timed out');
}
try {
  send('start', { settings });
  const first = await wait('started');
  assert.ok(first.accountCapabilities.includes('account-recovery'));
  send('account-setup', { requestId: 'synthetic-setup' });
  const setup = await wait('account-result', 'synthetic-setup'); assert.ok(!setup.error);
  const post = (body: unknown) => fetch(url + '/api/auth/invite', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const accepted = await post({ token: new URL(setup.setupUrl).hash.slice(1), username: 'synthetic-owner', password: 'synthetic-original-password' });
  assert.equal(accepted.status, 200); const user = await accepted.json() as { id: string; username: string };
  assert.equal(user.username, 'synthetic-owner');
  const cookie = accepted.headers.get('set-cookie')!.split(';')[0];
  send('account-users', { requestId: 'synthetic-users' });
  const listed = await wait('account-result', 'synthetic-users'); assert.ok(!listed.error); assert.equal(listed.users[0].id, user.id);
  send('account-recovery', { requestId: 'synthetic-recovery', userId: user.id });
  const recovery = await wait('account-result', 'synthetic-recovery'); assert.ok(!recovery.error);
  assert.equal((await post({ token: new URL(recovery.setupUrl).hash.slice(1), password: 'synthetic-new-password' })).status, 200);
  assert.equal((await fetch(url + '/api/me', { headers: { cookie } })).status, 401);
  send('account-recovery', { requestId: 'synthetic-invalid-user', userId: 'missing' });
  assert.ok((await wait('account-result', 'synthetic-invalid-user')).error);
  // Account errors remain local to the dialog and do not stop the supervisor.
  send('status'); assert.equal((await wait('status')).ready, true);
  const exited = once(child, 'exit'); send('quit'); await exited;
  console.log('PASS: supervisor capability negotiation, setup-link refresh, chosen username, account listing, recovery, session revocation, isolated account errors and clean Quit');
} finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
