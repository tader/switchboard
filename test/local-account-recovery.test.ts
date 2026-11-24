import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-recovery-test-'));
process.env.SWITCHBOARD_DATA_DIR = root;
process.env.SWITCHBOARD_PUBLIC_URL = 'http://127.0.0.1:8779';
process.env.SWITCHBOARD_UPDATE_CHECKS = 'false';
const database = await import('../server/db.ts');
const { initDb, one, run } = database;
const users = await import('../server/users.ts');
const { sha256 } = await import('../server/crypto.ts');
const { account } = await import('../server/routes/account.ts');
const { localAccountAction, localAccountCapabilities } = await import('../server/local-manager.ts');
const { localUpdateControl } = await import('../server/updates/control.ts');
initDb();
const db = database.db;
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const tokenOf = (url: string) => new URL(url).hash.slice(1);

test('initial setup permits username choice only until an account is established', () => {
  const link = users.ensureAdmin()!;
  const token = tokenOf(link);
  assert.equal(users.inviteAllowsUsername(token), true);
  assert.throws(() => users.acceptInvite(token, 'short', 'newname'));
  assert.equal(users.inviteAllowsUsername(token), true);
  assert.throws(() => users.acceptInvite(token, 'synthetic-password', 'invalid username'));
  users.createUser('taken-name', 'user');
  assert.throws(() => users.acceptInvite(token, 'synthetic-password', 'taken-name'));
  assert.equal(users.inviteAllowsUsername(token), true);
  const admin = users.acceptInvite(token, 'synthetic-password', 'sample-admin');
  assert.equal(admin.username, 'sample-admin'); assert.equal(admin.role, 'admin');
  assert.equal(users.ensureAdmin(), undefined);
  assert.throws(() => users.acceptInvite(token, 'synthetic-password-again', 'renamed'));
  const ordinary = tokenOf(users.createInvite(admin.id).url);
  assert.equal(users.inviteAllowsUsername(ordinary), false);
  assert.throws(() => users.acceptInvite(ordinary, 'synthetic-password-again', 'renamed'));
  assert.equal(users.getUser(admin.id)!.username, 'sample-admin');
});

test('recovery links expire, replace older links, preserve roles and revoke sessions only on completion', () => {
  const user = users.createUser('sample-user', 'user');
  users.setPassword(user.id, 'synthetic-original-password');
  const session = users.createSession(user.id);
  const first = users.createLocalRecoveryInvite(user.id);
  assert.ok(first.expiresAt <= Date.now() + 600_000 && first.expiresAt > Date.now() + 590_000);
  const second = users.createLocalRecoveryInvite(user.id);
  assert.equal(users.inviteUser(tokenOf(first.url)), undefined);
  assert.ok(users.sessionUser(session));
  assert.throws(() => users.acceptInvite(tokenOf(second.url), 'synthetic-new-password', 'takeover'));
  assert.equal(users.getUser(user.id)!.username, 'sample-user');
  const recovered = users.acceptInvite(tokenOf(second.url), 'synthetic-new-password');
  assert.equal(recovered.role, 'user'); assert.equal(recovered.disabled, false);
  assert.equal(users.sessionUser(session), undefined);
  assert.ok(users.checkLogin('sample-user', 'synthetic-new-password'));
  assert.throws(() => users.acceptInvite(tokenOf(second.url), 'synthetic-password-again'));
  const expired = users.createLocalRecoveryInvite(user.id);
  run('UPDATE invites SET expires_at = 0 WHERE user_id = ?', user.id);
  assert.equal(users.inviteUser(tokenOf(expired.url)), undefined);
  assert.throws(() => users.acceptInvite(tokenOf(expired.url), 'synthetic-expired-password'));
  const events = db.prepare('SELECT event FROM account_security_events WHERE user_id = ?').all(user.id);
  assert.equal(events.filter(e => e.event === 'local-recovery-completed').length, 1);
  const stored = one('SELECT token_hash FROM invites WHERE user_id = ?', user.id);
  assert.equal(stored.token_hash, sha256(tokenOf(expired.url)));
  assert.ok(!JSON.stringify(events).includes(tokenOf(expired.url)));
});

test('disabled, deleted and peer-shadow accounts cannot be recovered, including after minting a link', () => {
  const user = users.createUser('sample-disabled', 'user');
  const link = users.createLocalRecoveryInvite(user.id);
  users.updateUser(user.id, { disabled: true });
  assert.throws(() => users.createLocalRecoveryInvite(user.id));
  assert.equal(users.inviteUser(tokenOf(link.url)), undefined);
  assert.throws(() => users.acceptInvite(tokenOf(link.url), 'synthetic-password'));
  assert.equal(users.getUser(user.id)!.disabled, true);
  users.updateUser(user.id, { disabled: false });
  run('UPDATE users SET peer_shadow = 1 WHERE id = ?', user.id);
  assert.throws(() => users.createLocalRecoveryInvite(user.id));
  assert.throws(() => users.acceptInvite(tokenOf(link.url), 'synthetic-password'));
  assert.throws(() => users.createLocalRecoveryInvite('missing'));
});

test('account IPC requires every opt-in condition and an active private parent connection', () => {
  const previousSend = process.send;
  const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  const previousMode = process.env.SWITCHBOARD_INSTALL_MODE;
  const previousOptIn = process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY;
  try {
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    process.send = (() => true) as typeof process.send;
    for (const [mode, optIn] of [['runtime', '0'], ['compose', '1'], ['checkout', '1']]) {
      process.env.SWITCHBOARD_INSTALL_MODE = mode; process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY = optIn;
      assert.deepEqual(localAccountCapabilities(), []);
      assert.throws(() => localAccountAction('account-recovery', 'missing'));
    }
    process.env.SWITCHBOARD_INSTALL_MODE = 'runtime'; process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY = '1';
    assert.ok(localAccountCapabilities().includes('account-recovery'));
    const result = localAccountAction('account-users') as { users: { id: string; username: string }[] };
    assert.ok(result.users.every(u => Object.keys(u).sort().join() === 'id,username'));
    assert.ok(!result.users.some(u => u.username === 'sample-disabled'));
    assert.throws(() => localAccountAction('unknown'));
    Object.defineProperty(process, 'connected', { configurable: true, value: false });
    assert.deepEqual(localAccountCapabilities(), []);
    assert.throws(() => localAccountAction('account-users'));
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    process.send = undefined;
    assert.deepEqual(localAccountCapabilities(), []);
  } finally {
    if (previousConnected) Object.defineProperty(process, 'connected', previousConnected); else Reflect.deleteProperty(process, 'connected');
    process.send = previousSend;
    if (previousMode === undefined) delete process.env.SWITCHBOARD_INSTALL_MODE; else process.env.SWITCHBOARD_INSTALL_MODE = previousMode;
    if (previousOptIn === undefined) delete process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY; else process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY = previousOptIn;
  }
});

test('no HTTP recovery minting route exists for browser, API, or updater credentials', async () => {
  const app = new Hono().route('/api', account);
  const user = users.listUsers().find(u => u.username === 'sample-user')!;
  const api = users.createToken(user.id, 'synthetic-token', null).secret;
  const updater = await localUpdateControl('pair') as { token: string };
  const session = users.createSession(user.id);
  const count = one('SELECT COUNT(*) AS n FROM invites').n;
  const credentials: Record<string, string>[] = [{}, { authorization: `Bearer ${api}` }, { authorization: `Bearer ${updater.token}` }, { cookie: `switchboard_session=${session}` }];
  for (const headers of credentials) {
    for (const route of ['/auth/recovery', '/auth/account-recovery', '/account-users', '/account-recovery']) {
      const response = await app.request('http://127.0.0.1:8779/api' + route, { method: 'POST', headers: { origin: 'http://127.0.0.1:8779', ...headers } });
      assert.equal(response.status, 404);
    }
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM invites').n, count);
});
