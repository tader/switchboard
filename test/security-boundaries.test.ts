import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-boundaries-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_PUBLIC_URL = 'https://switchboard.example.test';
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
const { initKey } = await import('../server/crypto.ts');
const database = await import('../server/db.ts');
initKey(); database.initDb();
const { createUser, setPassword, createToken, createInvite } = await import('../server/users.ts');
const { account } = await import('../server/routes/account.ts');
const { registerEndpoint, authorizeApi } = await import('../server/routes/provider.ts');
const { HttpError } = await import('../server/http.ts');
for (const app of [account, registerEndpoint, authorizeApi]) app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as any : 500));
const { callbackUri } = await import('../server/oauth-redirect.ts');
const { redactBody, redactUrl, redactHeaders } = await import('../server/audit.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const user = createUser('security-fixture', 'admin');
setPassword(user.id, 'fixture password');
const token = createToken(user.id, 'fixture', null).secret;
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const owner = { authorization: 'Bearer ' + token };
after(async () => { await plugins.stop(); database.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('OAuth callbacks preserve native and loopback clients and reject document schemes for stored clients and denial', async () => {
  const unsafe = ['javascript:void(0)//', 'data:text/html,fixture', 'blob:https://client.example/fixture', 'file:///fixture', 'about:blank', 'https://client.example/cb#fragment'];
  for (const uri of unsafe) {
    const response = await registerEndpoint.request('https://switchboard.example.test/', json({ redirect_uris: [uri] }));
    assert.equal(response.status, 400, uri);
    assert.throws(() => callbackUri(uri));
  }
  for (const uri of ['https://client.example/cb', 'http://127.0.0.1:48731/cb', 'http://[::1]:48731/cb', 'com.example.app:/callback', 'vscode://fixture/callback', 'msauth://fixture/callback']) {
    assert.equal((await registerEndpoint.request('https://switchboard.example.test/', json({ redirect_uris: [uri] }))).status, 201, uri);
  }
  database.run('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)', 'swbc_legacy', 'Fixture', JSON.stringify([unsafe[0]]), Date.now());
  for (const approve of [false, true]) {
    const response = await authorizeApi.request('https://switchboard.example.test/', json({ client_id: 'swbc_legacy', redirect_uri: unsafe[0], response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', approve }, owner));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).redirect, undefined);
  }
  // Plain origin clients intentionally retain the existing HTTP warning flow.
  const httpClient = await authorizeApi.request('https://switchboard.example.test/', json({ client_id: 'http://client.example', redirect_uri: 'http://client.example/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', approve: false }, owner));
  assert.equal(httpClient.status, 200);
  const valid = await registerEndpoint.request('https://switchboard.example.test/', json({ redirect_uris: ['com.example.app:/callback'] }));
  const client = await valid.json();
  const denied = await authorizeApi.request('https://switchboard.example.test/', json({ client_id: client.client_id, redirect_uri: 'com.example.app:/callback', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', approve: false }, owner));
  assert.equal(denied.status, 200);
  assert.equal(new URL((await denied.json()).redirect).searchParams.get('error'), 'access_denied');
});

test('browser authentication posts reject cross-origin submissions while CLI and same-origin sign-in remain usable', async () => {
  const cross = { origin: 'https://other.example.test', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' };
  for (const [endpoint, body] of [['login', { username: user.username, password: 'fixture password' }], ['logout', {}], ['invite', { token: 'fixture', password: 'fixture password' }]] as const) {
    assert.equal((await account.request('https://switchboard.example.test/auth/' + endpoint, json(body, cross))).status, 403);
  }
  const before = database.one('SELECT count(*) AS n FROM sessions').n;
  const login = await account.request('https://switchboard.example.test/auth/login', json({ username: user.username, password: 'fixture password' }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const logout = await account.request('https://switchboard.example.test/auth/logout', json({}, { cookie, ...cross }));
  assert.equal(logout.status, 403);
  assert.equal(database.one('SELECT count(*) AS n FROM sessions').n, before + 1);
  assert.equal((await account.request('https://switchboard.example.test/auth/logout', json({}, { cookie, origin: 'https://switchboard.example.test', 'sec-fetch-site': 'same-origin' }))).status, 200);
  const invited = createUser('invite-fixture', 'user');
  const invite = createInvite(invited.id).url.split('#')[1];
  assert.equal((await account.request('https://switchboard.example.test/auth/invite', json({ token: invite, password: 'fixture password' }, { origin: 'https://switchboard.example.test', 'sec-fetch-site': 'same-origin' }))).status, 200);
});

test('login throttling canonicalizes aliases of the same account', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await account.request('https://switchboard.example.test/auth/login', json({ username: '  SECURITY-FIXTURE  ', password: 'incorrect password' }, { 'x-forwarded-for': 'fixture-address' }))).status, 401);
  }
  assert.equal((await account.request('https://switchboard.example.test/auth/login', json({ username: 'security-fixture', password: 'fixture password' }, { 'x-forwarded-for': 'fixture-address' }))).status, 429);
});

test('audit redaction omits secrets in arrays, objects, deep and malformed structured bodies', () => {
  let deep: any = { password: 'fixture-private' };
  for (let i = 0; i < 24; i++) deep = { child: deep };
  for (const body of [{ access_token: ['fixture-private'] }, { credentials: { value: 'fixture-private' } }, deep]) {
    assert.ok(!redactBody(JSON.stringify(body), 'application/json')!.includes('fixture-private'));
  }
  assert.ok(!redactBody('{"password":"fixture-private",', 'application/json')!.includes('fixture-private'));
  const url = redactUrl('https://fixture-private:fixture-private@provider.example/?api_key=fixture-private&pageToken=visible');
  assert.ok(!url.includes('fixture-private'));
  assert.ok(url.includes('pageToken=visible'));
  assert.ok(!redactUrl('/path?api_key=fixture-private').includes('fixture-private'));
  assert.ok(!redactUrl('https://%?password=fixture-private').includes('fixture-private'));
  assert.ok(!JSON.stringify(redactHeaders([{ name: 'authorization', value: 'Bearer •••••••• fixture-private', byHub: false }])).includes('fixture-private'));
  assert.equal(redactBody('{"message":"visible","pageToken":"cursor"}', 'application/json'), '{"message":"visible","pageToken":"cursor"}');
});

test('shared API responses keep owner query credentials off the peer wire', async t => {
  const fixture = path.join(dir, 'plugins/query-fixture'); fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'plugin.json'), JSON.stringify({ id: 'query-fixture', name: 'Fixture', version: '1.0.0', dependencies: ['api-key'] }));
  fs.writeFileSync(path.join(fixture, 'index.js'), "export default ctx=>({services:[{id:'query-fixture',name:'Fixture',baseUrl:'https://provider.example',authMethods:[ctx.require('api-key').queryKey({param:'private_key'})]}]});");
  await plugins.start();
  const { startConnect } = await import('../server/connections.ts');
  const { createPeer } = await import('../server/peers.ts');
  const { setConnectionShares } = await import('../server/peer-settings.ts');
  const { handleSharedRequest } = await import('../server/peer-agent.ts');
  const connected = await startConnect(user, { service: 'query-fixture', method: 'query', config: { key: 'fixture-owner-key' } });
  if (connected.status !== 'connected') throw Error('Expected connected');
  const peer = createPeer('Fixture peer', user.id).peer;
  setConnectionShares(user.id, connected.connection.id, { peerIds: [peer.id] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (value: URL) => {
    assert.equal(value.searchParams.get('private_key'), 'fixture-owner-key'); requests++;
    return Response.json({ ok: true });
  });
  const result = await handleSharedRequest(peer.id, 'fixture-remote-user', 'call', { connection: connected.connection.id, input: { method: 'GET', url: '/' } });
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(result).includes('fixture-owner-key'));
  assert.deepEqual(JSON.parse(Buffer.from(result.body, 'base64').toString()), { ok: true });
  assert.equal(database.one('SELECT count(*) AS n FROM connection_credential_shares').n, 0);
});
