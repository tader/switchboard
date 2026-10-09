import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { installFixturePlugins } from './plugin-fixtures.ts';
import WebSocket from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const saKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let saTokens = 0;

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
let hub: ChildProcess;
let base = '';
let peer: http.Server;
let up = '';
let cookie = '';
let output = '';
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let tokenCounter = 0;
let lastRedirectUri: string | null = null;
let devicePolls = 0;

/** Fake API + OAuth provider. */
function startPeer() {
  peer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, 'http://x');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/token') {
      const p = new URLSearchParams(body);
      const grant = p.get('grant_type');
      if (grant === 'authorization_code') lastRedirectUri = p.get('redirect_uri');
      if (grant === 'authorization_code' && p.get('code') === 'good' && p.get('code_verifier')) {
        return json(200, { access_token: `at-${++tokenCounter}`, refresh_token: 'rt', expires_in: 1, token_type: 'bearer' });
      }
      if (grant === 'refresh_token' && p.get('refresh_token') === 'rt') return json(200, { access_token: `at-${++tokenCounter}`, expires_in: 3600 });
      if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const [h, c, sig] = p.get('assertion')!.split('.');
        const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), saKeys.publicKey, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        if (!valid || claims.iss !== 'sa@proj.iam.gserviceaccount.com' || claims.aud !== `${up}/token` || claims.exp - claims.iat !== 3600) return json(400, { error: 'invalid_grant' });
        if (claims.sub !== 'user@example.com') return json(401, { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' });
        return json(200, { access_token: `sa-${++saTokens}:${claims.scope}`, expires_in: 3600 });
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (++devicePolls < 2) return json(400, { error: 'authorization_pending' });
        return json(200, { access_token: 'device-at', token_type: 'bearer' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/spec.json') {
      return json(200, {
        openapi: '3.0.0', info: { title: 'Fake', version: '1' },
        servers: [{ url: 'https://{domain}/api/v2', variables: { domain: { default: 'example.com' } } }],
        paths: { '/things/{id}': {
          get: { summary: 'Get a thing', parameters: [
            { name: 'id', in: 'path', required: true },
            { name: 'hideCompleted', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'nextToken', in: 'query', schema: { type: 'string' } },
          ] },
          post: {
            operationId: 'updateThing', summary: 'Update a thing',
            parameters: [{ name: 'id', in: 'path', required: true }, { name: 'x-mode', in: 'header', required: true, schema: { type: 'string', enum: ['safe', 'fast'] } }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } } } },
          },
        } },
      });
    }
    if (url.pathname === '/client.json') return json(200, { client_id: `${up}/client.json`, client_name: 'CIMD App', redirect_uris: ['http://localhost:9000/cb'] });
    if (url.pathname === '/forged-client.json') return json(200, { client_id: 'https://claude.ai/oauth/client.json', client_name: 'Claude', redirect_uris: ['http://localhost:9000/cb'] });
    if (url.pathname === '/device') return json(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: `${up}/activate`, interval: 0, expires_in: 600 });
    seen.push({ url: req.url!, headers: req.headers, body });
    if (req.headers.authorization === 'Bearer expired') return json(401, { error: 'nope' });
    json(200, { ok: true, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null });
  });
  return new Promise<void>((r) => peer.listen(0, '127.0.0.1', () => {
    up = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    r();
  }));
}

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
};

before(async () => {
  installFixturePlugins(dataDir);
  await startPeer();
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  hub = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], {
    cwd: root,
    env: { ...process.env, SWITCHBOARD_PORT: String(port), SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_PUBLIC_URL: base, SWITCHBOARD_HOST: '127.0.0.1' },
  });
  hub.stdout!.on('data', (d) => (output += d));
  hub.stderr!.on('data', (d) => (output += d));
  await waitFor(() => output.includes('Switchboard listening'));
});

after(() => {
  hub?.kill();
  peer?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let apiToken = '';
let connId = '';
let aliceId = '';
let aliceCookie = '';

test('setup link lets the admin set a password and sign in', async () => {
  const token = output.match(/\/invite#(\S+)/)![1];
  assert.equal((await req('GET', `/api/auth/invite/${token}`)).data.username, 'admin');
  assert.equal((await req('POST', '/api/auth/invite', { token, password: 'short' })).status, 400);
  const r = await req('POST', '/api/auth/invite', { token, password: 'correct horse battery' });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/me')).data.role, 'admin');
  assert.equal((await req('POST', '/api/auth/invite', { token, password: 'again again' })).status, 400, 'invite is single use');
});

test('names from before the rename to Switchboard keep working', async () => {
  const value = cookie.split('=')[1];
  const legacy = await fetch(`${base}/api/me`, { headers: { cookie: `hub_session=${value}` } });
  assert.equal((await legacy.json()).username, 'admin', 'old cookie name');
  const t = (await req('POST', '/api/tokens', { name: 'legacy-header' })).data.secret;
  const viaOldHeader = await fetch(`${base}/api/me`, { headers: { 'x-hub-token': t } });
  assert.equal((await viaOldHeader.json()).username, 'admin', 'X-Hub-Token header');
  const viaNewHeader = await fetch(`${base}/api/me`, { headers: { 'x-switchboard-token': t } });
  assert.equal(viaNewHeader.status, 200);
});

test('plugin update route validates optional ref without swallowing malformed JSON', async () => {
  for (const body of [null, [], { ref: false }, { ref: '' }, { ref: 'bad ref' }]) {
    const r = await req('POST', '/api/admin/plugins/api-key/update', body);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /ref|object/);
  }
  const malformed = await fetch(`${base}/api/admin/plugins/api-key/update`, {
    method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  for (const body of [undefined, {}, { ref: null }, { ref: 'feature/testing' }]) {
    const r = await req('POST', '/api/admin/plugins/api-key/update', body);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Only plugins installed from GitHub/);
  }
});

test('cross-site requests with the session cookie are rejected', async () => {
  const r = await req('POST', '/api/tokens', { name: 'x' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('plugins and services are listed', async () => {
  const plugins = (await req('GET', '/api/admin/plugins')).data;
  assert.deepEqual(plugins.filter((p: any) => p.origin === 'builtin').map((p: any) => p.id).sort(), ['api-key', 'mcp', 'oauth2']);
  assert.equal(plugins.find((p: any) => p.id === 'github').origin, 'installed');
  const gmail = plugins.find((p: any) => p.id === 'gmail');
  assert.equal(gmail.status, 'active');
  assert.deepEqual(gmail.dependencies, ['google']);
  assert.equal(plugins.find((p: any) => p.id === 'apple-reminders'), undefined, 'Apple Reminders is installed from its external repository');
  assert.equal(plugins.find((p: any) => p.id === 'atlassian'), undefined, 'Atlassian is installed from its external repository');
  const services = (await req('GET', '/api/services')).data;
  assert.ok(services.filter((s: any) => s.id !== 'mcp').every((s: any) => s.kind === 'http'));
  assert.equal(services.find((s: any) => s.id === 'mcp').kind, 'mcp');
  const gh = services.find((s: any) => s.id === 'github');
  assert.deepEqual(gh.methods.map((m: any) => m.id), ['token', 'oauth', 'device']);
  assert.ok(gh.methods.find((m: any) => m.id === 'oauth').unavailable);

  const methods = (id: string) => services.find((s: any) => s.id === id)?.methods.map((m: any) => m.id);
  assert.deepEqual(methods('home-assistant'), ['oauth', 'token']);
  assert.equal(methods('jira'), undefined, 'Jira is installed from the external Atlassian repository');
  assert.equal(methods('confluence'), undefined, 'Confluence is installed from the external Atlassian repository');
  assert.deepEqual(methods('todoist'), ['token', 'oauth']);
  assert.deepEqual(methods('spotify'), ['oauth', 'app']);
  assert.deepEqual(methods('plex'), ['plex', 'link', 'token']);
  assert.equal(services.some((s: any) => s.id === 'switchboard'), false);
  assert.equal((await req('PATCH', '/api/admin/plugins/switchboard', { enabled: true })).status, 400);
  assert.equal(methods('apple-reminders'), undefined, 'Apple Reminders is no longer a built-in service');
  assert.ok(methods('google-docs') && methods('google-sheets'));
  for (const p of plugins.filter((p: any) => p.id !== 'switchboard')) assert.equal(p.status, 'active', `${p.id}: ${p.error}`);
});

test('API descriptions with a placeholder server use the connection base URL', async () => {
  const c = await req('POST', '/api/connections', { service: 'http', method: 'token', config: { baseUrl: up, token: 't', openapi: `${up}/spec.json` } });
  assert.equal(c.data.connection.kind, 'http');
  assert.equal((await req('GET', `/api/connections/${c.data.connection.id}`)).data.kind, 'http');
  const d = (await req('GET', `/api/connections/${c.data.connection.id}/openapi`)).data;
  assert.equal(d.server, `${up}/api/v2`);
  assert.equal(d.operations[0].path, '/things/{id}');
  await req('DELETE', `/api/connections/${c.data.connection.id}`);
});

test('connect an API with a bearer token and call it through the proxy', async () => {
  const r = await req('POST', '/api/connections', { service: 'http', method: 'token', config: { baseUrl: up, token: 'secret-1', label: 'Fake' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'connected');
  connId = r.data.connection.id;
  assert.equal(r.data.connection.config.token, undefined, 'secrets are not returned');

  const t = await req('POST', '/api/tokens', { name: 'script' });
  apiToken = t.data.secret;
  assert.match(apiToken, /^swb_/);

  const res = await fetch(`${base}/proxy/${r.data.connection.name}/items?a=1`, { headers: { authorization: `Bearer ${apiToken}`, 'x-custom': 'y' } });
  const data = await res.json();
  assert.equal(data.auth, 'Bearer secret-1');
  assert.equal(data.path, '/items');
  assert.equal(data.query.a, '1');
  assert.equal(seen.at(-1)!.headers['x-custom'], 'y');
  assert.ok(!JSON.stringify(seen.at(-1)!.headers).includes(apiToken), 'Switchboard token is not forwarded');
});

test('credentials are only sent to allowed hosts', async () => {
  const r = await req('POST', '/api/call', { connection: connId, method: 'GET', url: 'https://example.com/steal' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not an allowed host/);
});

test('JSON call API with path params, query and body', async () => {
  const r = await req('POST', '/api/call', {
    connection: connId,
    method: 'POST',
    url: '/users/{id}',
    pathParams: { id: 'a b/c?d' },
    query: [{ key: 'x', value: '1' }, { key: 'off', value: '2', enabled: false }],
    headers: [{ key: 'content-type', value: 'application/json' }],
    body: '{"hello":1}',
  }, { authorization: `Bearer ${apiToken}` });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.data.body);
  assert.equal(body.path, '/users/a%20b/c%3Fd', 'escaped per segment; "/" stays a separator');
  assert.deepEqual(body.query, { x: '1' });
  assert.equal(seen.at(-1)!.body, '{"hello":1}');

  // What was sent, with the credential masked
  const sent = r.data.request;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, `${up}/users/a%20b/c%3Fd?x=1`);
  assert.equal(sent.body, '{"hello":1}');
  assert.deepEqual(sent.headers.find((h: any) => h.name === 'authorization'), { name: 'authorization', value: 'Bearer ••••••••', byHub: true });
  assert.deepEqual(sent.headers.find((h: any) => h.name === 'content-type'), { name: 'content-type', value: 'application/json', byHub: false });
  assert.ok(!JSON.stringify({ ...r.data, body: '' }).includes('secret-1'), 'the credential appears nowhere but in what peer echoed');
});

test('API keys in the query string are masked in the console envelope', async () => {
  const c = await req('POST', '/api/connections', { service: 'http', method: 'query', config: { baseUrl: up, key: 'qkey-secret', param: 'api_key' } });
  const r = await req('POST', '/api/call', { connection: c.data.connection.id, url: '/q', query: { page: '2' } });
  assert.equal(JSON.parse(r.data.body).query.api_key, 'qkey-secret', 'sent peer');
  assert.equal(r.data.request.url, `${up}/q?page=2&api_key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2`);
  assert.equal(r.data.url, r.data.request.url);
  assert.ok(!JSON.stringify({ ...r.data, body: '' }).includes('qkey-secret'));
  await req('DELETE', `/api/connections/${c.data.connection.id}`);
});

test('saved calls can be run with overrides', async () => {
  const s = await req('POST', '/api/calls', { name: 'List', connectionId: connId, method: 'GET', url: '/list', query: [{ key: 'page', value: '1' }] });
  assert.equal(s.status, 201);
  const res = await fetch(`${base}/api/calls/List/run`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ query: { page: '2' } }) });
  const data = await res.json();
  assert.equal(data.path, '/list');
  assert.equal(data.query.page, '2');
});

test('tokens limited to one connection cannot use others or manage anything', async () => {
  const other = await req('POST', '/api/connections', { service: 'http', method: 'header', config: { baseUrl: up, key: 'k2', header: 'X-Key' } });
  const t = await req('POST', '/api/tokens', { name: 'limited', connectionIds: [connId] });
  const h = { authorization: `Bearer ${t.data.secret}` };
  assert.equal((await req('GET', '/api/connections', undefined, h)).data.length, 1);
  assert.equal((await req('POST', '/api/call', { connection: other.data.connection.id, url: '/' }, h)).status, 403);
  assert.equal((await req('POST', '/api/call', { connection: connId, url: '/' }, h)).status, 200);
  assert.equal((await req('GET', '/api/admin/users', undefined, h)).status, 403);
  assert.equal((await req('POST', '/api/tokens', { name: 'escalate' }, h)).status, 403);

  const res = await req('POST', '/api/call', { connection: other.data.connection.id, url: '/' });
  assert.equal(JSON.parse(res.data.body).auth, null);
  assert.equal(seen.at(-1)!.headers['x-key'], 'k2');
});

test('OAuth authorization code flow with PKCE and refresh', async () => {
  const r = await req('POST', '/api/connections', {
    service: 'oauth2',
    method: 'oauth',
    config: { authorizeUrl: `${up}/authorize`, tokenUrl: `${up}/token`, baseUrl: up, clientId: 'cid', clientSecret: 'cs', scopes: 'read' },
  });
  assert.equal(r.data.status, 'redirect');
  const url = new URL(r.data.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), `${base}/oauth/callback`);
  const cb = await req('GET', `/oauth/callback?state=${url.searchParams.get('state')}&code=good`);
  assert.equal(cb.status, 302);
  const id = new URL(cb.headers.get('location')!).searchParams.get('connected');
  assert.ok(id, cb.headers.get('location')!);

  // The first token expires within a second, so the call refreshes it.
  await new Promise((r) => setTimeout(r, 50));
  const call = await req('POST', '/api/call', { connection: id, url: '/me' });
  assert.equal(JSON.parse(call.data.body).auth, `Bearer at-${tokenCounter}`);
  assert.equal(tokenCounter, 2);
  const tok = await req('GET', `/api/connections/${id}/token`);
  assert.equal(tok.data.access_token, 'at-2');
});

test('OAuth with another redirect URI: paste the address to complete', async () => {
  const config = { authorizeUrl: `${up}/authorize`, tokenUrl: `${up}/token`, baseUrl: up, clientId: 'cid', scopes: 'read' };
  const start = (extra = {}) => req('POST', '/api/connections', { service: 'oauth2', method: 'oauth', config, redirectUri: 'http://localhost:9999/callback', ...extra });

  const services = (await req('GET', '/api/services')).data;
  const methods = services.find((s: any) => s.id === 'oauth2').methods;
  assert.deepEqual(methods.map((m: any) => [m.id, m.redirect]), [['oauth', true], ['device', false], ['client-credentials', false]]);

  const r = await start();
  assert.equal(r.data.status, 'redirect');
  assert.equal(r.data.manual, true);
  const authorize = new URL(r.data.url);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:9999/callback');
  const state = authorize.searchParams.get('state')!;

  const wrong = await req('POST', `/api/connect/${r.data.flowId}/complete`, { url: 'http://localhost:9999/callback?code=good&state=someone-else' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /another sign-in/);
  assert.match((await req('POST', `/api/connect/${r.data.flowId}/complete`, { url: 'http://localhost:9999/callback?foo=bar' })).data.error, /no code/);

  const done = await req('POST', `/api/connect/${r.data.flowId}/complete`, { url: `http://localhost:9999/callback?code=good&state=${state}&session_state=x` });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.connection.redirectUri, 'http://localhost:9999/callback', 'remembered for reconnecting');
  assert.equal(lastRedirectUri, 'http://localhost:9999/callback', 'the token request names the same redirect URI');

  // Just the code works too, and the address may carry it in the fragment.
  const second = await start({ name: 'pasted-code' });
  assert.equal((await req('POST', `/api/connect/${second.data.flowId}/complete`, { url: 'good' })).status, 200);
  const third = await start({ name: 'fragment' });
  const s3 = new URL(third.data.url).searchParams.get('state');
  assert.equal((await req('POST', `/api/connect/${third.data.flowId}/complete`, { url: `http://localhost:9999/callback#code=good&state=${s3}` })).status, 200);

  assert.equal((await req('POST', '/api/connections', { service: 'oauth2', method: 'device', config: { ...config, deviceAuthorizationUrl: `${up}/device` }, redirectUri: 'http://localhost:1/x' })).status, 400, 'device flow has no redirect');
  assert.equal((await start({ redirectUri: 'javascript:alert(1)' })).status, 400);
  assert.equal((await start({ redirectUri: 'not a url' })).status, 400);

  // Without an override, nothing changes.
  const normal = await req('POST', '/api/connections', { service: 'oauth2', method: 'oauth', config });
  assert.equal(normal.data.manual, undefined);
  assert.equal(new URL(normal.data.url).searchParams.get('redirect_uri'), `${base}/oauth/callback`);
});

test('OAuth device flow', async () => {
  const r = await req('POST', '/api/connections', {
    service: 'oauth2',
    method: 'device',
    config: { deviceAuthorizationUrl: `${up}/device`, tokenUrl: `${up}/token`, baseUrl: up, clientId: 'cid', label: 'Device account' },
  });
  assert.equal(r.data.status, 'device');
  assert.equal(r.data.device.userCode, 'ABCD-1234');
  assert.equal((await req('POST', `/api/connect/${r.data.flowId}/poll`)).data.status, 'pending');
  const done = await req('POST', `/api/connect/${r.data.flowId}/poll`);
  assert.equal(done.data.status, 'connected');
  assert.equal(done.data.connection.account.label, 'Device account');
});

test('plugins hot-reload from disk, with dependencies', async () => {
  const dir = path.join(dataDir, 'plugins', 'echo');
  fs.mkdirSync(dir, { recursive: true });
  const write = (v: string) => {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'echo', name: 'Echo', version: v, dependencies: ['api-key'] }));
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      `import { label } from './lib.ts';
       export default (ctx) => ({ services: [{ id: 'echo', name: label, baseUrl: '${up}', authMethods: [ctx.require('api-key').bearerToken()] }] });`,
    );
    fs.writeFileSync(path.join(dir, 'lib.ts'), `export const label: string = 'Echo ${v}';`);
  };
  write('1');
  await waitFor(async () => (await req('GET', '/api/services')).data.some((s: any) => s.name === 'Echo 1'));
  write('2');
  await waitFor(async () => (await req('GET', '/api/services')).data.some((s: any) => s.name === 'Echo 2'));

  // Disabling a dependency blocks dependents, enabling it brings them back.
  await req('PATCH', '/api/admin/plugins/api-key', { enabled: false });
  const echo = (await req('GET', '/api/admin/plugins/echo')).data;
  assert.equal(echo.status, 'blocked');
  assert.equal((await req('GET', `/api/connections/${connId}`)).data.status, 'unavailable');
  await req('PATCH', '/api/admin/plugins/api-key', { enabled: true });
  assert.equal((await req('GET', '/api/admin/plugins/echo')).data.status, 'active');
  assert.equal((await req('GET', `/api/connections/${connId}`)).data.status, 'ok');

  fs.rmSync(dir, { recursive: true });
  await waitFor(async () => !(await req('GET', '/api/services')).data.some((s: any) => s.id === 'echo'));
});

test('same account: reconnecting updates, another method or a name adds a connection', async () => {
  const dir = path.join(dataDir, 'plugins', 'dup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'dup', name: 'Dup', version: '1' }));
  const method = (id: string) => `{ id: '${id}', name: '${id}', connect: ({ config }) => ({ credentials: { v: config.v }, account: { id: 'same', label: 'Same' } }), authorize() {} }`;
  fs.writeFileSync(path.join(dir, 'index.ts'), `export default () => ({ services: [{ id: 'dup', name: 'Dup', baseUrl: '${up}', authMethods: [${method('a')}, ${method('b')}] }] });`);
  await waitFor(async () => (await req('GET', '/api/services')).data.some((s: any) => s.id === 'dup'));
  const connect = (body: any) => req('POST', '/api/connections', { service: 'dup', ...body });
  const ids = async () => (await req('GET', '/api/connections')).data.filter((c: any) => c.serviceId === 'dup').map((c: any) => c.id);

  const first = (await connect({ method: 'a' })).data.connection;
  assert.equal((await connect({ method: 'a' })).data.connection.id, first.id, 'same account and method updates');
  const byOtherMethod = (await connect({ method: 'b' })).data.connection;
  assert.notEqual(byOtherMethod.id, first.id);
  assert.equal((await req('GET', `/api/connections/${first.id}`)).data.methodId, 'a', 'first connection untouched');
  const named = (await connect({ method: 'a', name: 'dup-second' })).data.connection;
  assert.equal(named.name, 'dup-second');
  assert.equal((await ids()).length, 3);
  const taken = await connect({ method: 'a', name: 'dup-second' });
  assert.equal(taken.status, 400);
  assert.match(taken.data.error, /already have a connection with that name/);

  for (const id of await ids()) await req('DELETE', `/api/connections/${id}`);
  fs.rmSync(dir, { recursive: true });
});

test('OAuth consent, PKCE, scoped calls and revocation remain available to clients', async () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = { client_id: `${base}/`, redirect_uri: `${base}/oauth/callback`, response_type: 'code', state: 'oauth-client-test',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  const query = new URLSearchParams(q);
  const page = await fetch(`${base}/oauth/authorize?${query}`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })}`)).status, 400);
  const approve = async () => new URL((await req('POST', '/api/oauth/authorize', { ...q, approve: true, connectionIds: [connId] })).data.redirect).searchParams.get('code')!;
  const redeem = async (code: string, codeVerifier: string) => fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: q.client_id, redirect_uri: q.redirect_uri, code_verifier: codeVerifier }) }).then(r => r.json());
  assert.equal((await redeem(await approve(), 'wrong')).error, 'invalid_grant');
  const code = await approve(); const issued = await redeem(code, verifier); assert.ok(issued.access_token);
  assert.equal((await redeem(code, verifier)).error, 'invalid_grant');
  const headers = { authorization: `Bearer ${issued.access_token}` };
  const listed = await fetch(`${base}/api/connections`, { headers }).then(r => r.json());
  assert.deepEqual(listed.map((c: any) => c.id), [connId]);
  const call = await fetch(`${base}/proxy/${connId}/chained`, { headers }).then(r => r.json());
  assert.equal(call.auth, 'Bearer secret-1');
  assert.equal((await fetch(`${base}/api/me/token`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(`${base}/api/connections`, { headers })).status, 401);
});

test('Google service account with domain-wide delegation', async () => {
  const services = (await req('GET', '/api/services')).data;
  const keep = services.find((s: any) => s.id === 'google-keep');
  assert.deepEqual(keep.methods.map((m: any) => m.id), ['service-account'], 'Google never lets users consent to Keep scopes');
  assert.deepEqual(services.find((s: any) => s.id === 'google').methods.map((m: any) => m.id), ['oauth', 'service-account']);

  const key = JSON.stringify({ type: 'service_account', client_email: 'sa@proj.iam.gserviceaccount.com', private_key: saKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${up}/token` });
  const denied = await req('POST', '/api/connections', { service: 'google-keep', method: 'service-account', config: { key, subject: 'other@example.com' } });
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /domain-wide delegation/, 'explains the usual cause');
  assert.match((await req('POST', '/api/connections', { service: 'google-keep', method: 'service-account', config: { key: '{nope', subject: 'x@y' } })).data.error, /not valid JSON/);

  const r = await req('POST', '/api/connections', { service: 'google-keep', method: 'service-account', config: { key, subject: 'user@example.com', access: 'readonly' } });
  assert.equal(r.data.status, 'connected', JSON.stringify(r.data));
  assert.equal(r.data.connection.account.label, 'user@example.com');
  assert.equal(r.data.connection.config.key, undefined, 'the key is not part of the visible config');
  const t = await req('GET', `/api/connections/${r.data.connection.id}/token`);
  assert.equal(t.data.access_token, `sa-${saTokens}:https://www.googleapis.com/auth/keep.readonly`, 'cached token is reused');
  const forced = await req('GET', `/api/connections/${r.data.connection.id}/token?force=1`);
  assert.equal(forced.data.access_token, `sa-${saTokens}:https://www.googleapis.com/auth/keep.readonly`);
  assert.notEqual(forced.data.access_token, t.data.access_token, 'force signs a new assertion');
  await req('DELETE', `/api/connections/${r.data.connection.id}`);
});

test('audit trail: every request recorded, redacted, filterable', async () => {
  const c = (await req('POST', '/api/connections', { service: 'http', method: 'token', config: { baseUrl: up, token: 'audit-secret' }, name: 'audited' })).data.connection;
  const agent = (await req('POST', '/api/tokens', { name: 'mail-agent', connectionIds: [c.id] })).data;
  const as = { authorization: `Bearer ${agent.secret}` };

  // An agent: proxy call with its own secret-looking values, a refused host, a raw token request.
  const res = await fetch(`${base}/proxy/audited/inbox?api_key=leak-1&pageToken=p2&q=hello`, {
    method: 'POST',
    headers: { ...as, 'content-type': 'application/json', 'x-api-key': 'leak-2' },
    body: JSON.stringify({ to: 'bob@example.com', password: 'leak-3', nested: { client_secret: 'leak-4' } }),
  });
  const echoed = await res.text();
  await req('POST', '/api/call', { connection: c.id, url: 'https://elsewhere.example/x' }, as);
  await req('GET', `/api/connections/${c.id}/token`, undefined, as);
  // The user, from the web console
  await req('POST', '/api/call', { connection: c.id, url: '/slow', method: 'GET' });

  const list = (q = '') => req('GET', `/api/audit?connection=${c.id}${q}`).then((r) => r.data);
  const all = await list();
  assert.equal(all.total, 4);
  assert.deepEqual(all.items.map((e: any) => e.source), ['console', 'token', 'call', 'proxy'], 'newest first');
  const proxied = all.items[3];
  assert.equal(proxied.client.name, 'mail-agent');
  assert.equal(proxied.status, 200);
  assert.equal(proxied.responseSize, Buffer.byteLength(echoed), 'size of the streamed response');
  assert.match(proxied.url, /pageToken=p2/, 'pagination cursors are not secrets');
  assert.match(proxied.url, /q=hello/);

  const detail = (await req('GET', `/api/audit/${proxied.id}`)).data;
  assert.equal(detail.requestHeaders.find((h: any) => h.name === 'authorization').value, 'Bearer ••••••••');
  assert.equal(detail.requestHeaders.find((h: any) => h.name === 'x-api-key').value, '••••••••');
  assert.match(detail.requestBody, /bob@example\.com/);
  const stored = JSON.stringify(await req('GET', `/api/audit?connection=${c.id}`).then((r) => r.data)) + JSON.stringify(detail);
  for (const secret of ['audit-secret', 'leak-1', 'leak-2', 'leak-3', 'leak-4', agent.secret]) assert.ok(!stored.includes(secret), `${secret} is redacted`);

  // Filters and sorting
  assert.equal((await list('&status=4xx')).items[0].error.includes('not an allowed host'), true);
  assert.equal((await list('&source=token')).items[0].method, 'TOKEN');
  assert.equal((await list(`&client=${agent.token.id}`)).total, 3);
  assert.equal((await list('&client=web')).total, 1);
  assert.equal((await list('&q=inbox')).total, 1);
  assert.equal((await list('&method=POST')).total, 1);
  assert.equal((await list(`&from=${Date.now() + 60_000}`)).total, 0);
  const byDuration = (await list('&sort=duration&order=asc')).items.map((e: any) => e.durationMs);
  assert.deepEqual(byDuration, [...byDuration].sort((a: number, b: number) => a - b));
  assert.equal((await list('&limit=2&offset=2')).items.length, 2);
  const facets = (await req('GET', '/api/audit/facets')).data;
  assert.ok(facets.clients.some((x: any) => x.name === 'mail-agent'));

  // Agents with a limited token cannot read the trail.
  assert.equal((await req('GET', '/api/audit', undefined, as)).status, 403);
  // Entries stay after the connection and token are gone.
  await req('DELETE', `/api/connections/${c.id}`);
  await req('DELETE', `/api/tokens/${agent.token.id}`);
  assert.equal((await list()).total, 4);
});

test('activity histogram: buckets, breakdowns, Other, URL grouping', async () => {
  const c = (await req('POST', '/api/connections', { service: 'http', method: 'token', config: { baseUrl: up, token: 't' }, name: 'histo' })).data.connection;
  for (const id of ['12345', '67890', 'AAMkAGI2THVSAAA1234567890abc']) await req('POST', '/api/call', { connection: c.id, url: `/users/${id}/items` });
  for (let i = 1; i <= 9; i++) await req('POST', '/api/call', { connection: c.id, url: `/path${i}?page=${i}` });
  await req('POST', '/api/call', { connection: c.id, url: 'https://not-allowed.example/x' });

  const from = Date.now() - 3600_000;
  const h = async (q: string) => (await req('GET', `/api/audit/histogram?connection=${c.id}&from=${from}&${q}`)).data;
  const byConn = await h('by=connection&tz=-120');
  assert.equal(byConn.interval, 60_000, 'one hour in minutes');
  assert.equal(byConn.series.length, 1);
  assert.equal(byConn.series[0].label, 'histo');
  const table = (await req('GET', `/api/audit?connection=${c.id}&from=${from}`)).data.total;
  assert.equal(byConn.series[0].total, table, 'chart and table agree');
  assert.equal(byConn.buckets.reduce((n: number, b: any) => n + (Object.values(b.values) as number[]).reduce((a, v) => a + v, 0), 0), table);
  // Buckets start on whole local minutes.
  for (const b of byConn.buckets) assert.equal(b.t % 60_000, 0);

  const byUrl = await h('by=url');
  assert.equal(byUrl.series.length, 8, 'seven series and Other');
  assert.match(byUrl.series.at(-1).label, /^Other \(\d+\)$/);
  assert.equal(byUrl.series[0].label, `${new URL(up).host}/users/{id}/items`, 'ids collapsed, largest first');
  assert.equal(byUrl.series[0].total, 3);
  assert.equal(byUrl.series.reduce((n: number, x: any) => n + x.total, 0), table, 'nothing lost to Other');

  const byStatus = await h('by=status');
  assert.deepEqual(byStatus.series.map((x: any) => x.key), ['2xx', '4xx']);
  assert.equal((await req('GET', '/api/audit/histogram?by=nope')).status, 400);

  // Zoomed into a window without requests
  const past = await h(`by=method&to=${from + 60_000}`);
  assert.equal(past.series.length, 0);
  await req('DELETE', `/api/connections/${c.id}`);
});

test('plugin settings keep secrets hidden', async () => {
  await req('PUT', '/api/admin/plugins/github/settings', { clientId: 'abc', clientSecret: 'shh' });
  const s = (await req('GET', '/api/admin/plugins/github/settings')).data;
  assert.equal(s.values.clientId, 'abc');
  assert.deepEqual(s.secretsSet, ['clientSecret']);
  assert.ok(!JSON.stringify(s).includes('shh'));
  await req('PUT', '/api/admin/plugins/github/settings', { clientId: 'abc2' });
  assert.deepEqual((await req('GET', '/api/admin/plugins/github/settings')).data.secretsSet, ['clientSecret'], 'secret kept');
  const gh = (await req('GET', '/api/services')).data.find((x: any) => x.id === 'github');
  assert.ok(!gh.methods.find((m: any) => m.id === 'oauth').unavailable);
});

test('docs: hub guides, plugin guides, links per service', async () => {
  const docs = (await req('GET', '/api/docs')).data;
  const ids = docs.map((d: any) => d.id);
  for (const id of ['guides/mcp', 'guides/api', 'guides/api-reference', 'guides/plugins', 'google/oauth-client', 'google-keep/setup']) assert.ok(ids.includes(id), id);
  assert.deepEqual([...new Set(docs.map((d: any) => d.section))], ['Using Switchboard', 'Services', 'Administration']);

  const mcp = (await req('GET', '/api/docs/guides/mcp')).data;
  assert.match(mcp.markdown, new RegExp(`claude mcp add --scope user --transport http switchboard ${base}/mcp`));
  assert.ok(!mcp.markdown.includes('{{'), 'placeholders filled');
  const google = (await req('GET', '/api/docs/google/oauth-client')).data;
  assert.match(google.markdown, new RegExp(`${base}/oauth/callback`));
  const authoring = (await req('GET', '/api/docs/guides/plugins')).data;
  assert.match(authoring.markdown, /`\{\{publicUrl\}\}`/, 'escaped placeholders stay literal');
  const ref = (await req('GET', '/api/docs/guides/api-reference')).data;
  assert.match(ref.markdown, /### `POST \/api\/call`/);

  const services = (await req('GET', '/api/services')).data;
  const guides = (id: string) => services.find((s: any) => s.id === id).guides.map((g: any) => g.id);
  assert.deepEqual(guides('gmail'), ['google/oauth-client'], 'dependents get the Google guide');
  assert.deepEqual(guides('google-keep'), ['google-keep/setup'], 'but Keep is excluded from it');
  assert.equal((await req('GET', '/api/docs/nope/nothing')).status, 404);
});

test('OAuth: unregistered client ids only with a loopback redirect', async () => {
  const q = { response_type: 'code', client_id: 'codex', redirect_uri: 'http://127.0.0.1:1455/auth/callback', state: 's', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', resource: `${base}/mcp` };
  const ok = await req('GET', `/api/oauth/authorize?${new URLSearchParams(q)}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.client, 'codex');
  assert.equal(ok.data.verifiedName, false);
  assert.equal((await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })}`)).status, 400);
});

test('Microsoft: services, sign-in request, tenant and permissions', async () => {
  const services = (await req('GET', '/api/services')).data;
  for (const id of ['microsoft-graph', 'outlook-mail', 'outlook-calendar', 'onedrive', 'microsoft-todo']) {
    const s = services.find((x: any) => x.id === id);
    assert.deepEqual(s.methods.map((m: any) => m.id), ['oauth', 'device'], id);
    assert.ok(s.guides.some((g: any) => g.id === 'microsoft/app-registration'), `${id} links the setup guide`);
  }
  const mail = services.find((x: any) => x.id === 'outlook-mail');
  assert.equal(mail.methods[0].fields.find((f: any) => f.key === 'clientId').required, true, 'needs a client id until an admin sets one');
  assert.ok(!mail.methods[1].fields.some((f: any) => f.key === 'clientSecret'), 'no secret for the device flow');

  const r = await req('POST', '/api/connections', { service: 'outlook-mail', method: 'oauth', config: { access: 'send', clientId: 'app-123' } });
  assert.equal(r.data.status, 'redirect', JSON.stringify(r.data));
  const u = new URL(r.data.url);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.deepEqual(u.searchParams.get('scope')!.split(' '), ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.Read', 'Mail.Send']);
  assert.equal(u.searchParams.get('client_id'), 'app-123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_mode'), 'query');

  await req('PUT', '/api/admin/plugins/microsoft/settings', { clientId: 'shared-app', tenant: 'consumers' });
  const after = (await req('GET', '/api/services')).data.find((x: any) => x.id === 'outlook-calendar');
  assert.equal(after.methods[0].fields.find((f: any) => f.key === 'clientId').required, false, 'optional once an admin configured it');
  const shared = new URL((await req('POST', '/api/connections', { service: 'outlook-calendar', method: 'oauth', config: {} })).data.url);
  assert.equal(shared.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(shared.searchParams.get('client_id'), 'shared-app');
  const tenant = new URL((await req('POST', '/api/connections', { service: 'outlook-calendar', method: 'oauth', config: { tenant: 'contoso.onmicrosoft.com' } })).data.url);
  assert.equal(tenant.pathname, '/contoso.onmicrosoft.com/oauth2/v2.0/authorize', 'per-connection tenant');
  const local = await req('POST', '/api/connections', { service: 'outlook-mail', method: 'oauth', config: {}, redirectUri: 'http://localhost:3000' });
  assert.equal(local.data.manual, true);
  assert.equal(new URL(local.data.url).searchParams.get('redirect_uri'), 'http://localhost:3000', 'Microsoft gets the override too');
});

test('users: invite, sign in, admin-only areas', async () => {
  const r = await req('POST', '/api/admin/users', { username: 'alice' });
  aliceId = r.data.user.id;
  const token = r.data.invite.url.split('#')[1];
  const adminCookie = cookie;
  cookie = '';
  await req('POST', '/api/auth/invite', { token, password: 'alice password' });
  assert.equal((await req('GET', '/api/me')).data.username, 'alice');
  assert.equal((await req('GET', '/api/admin/plugins')).status, 403);
  assert.ok(!(await req('GET', '/api/docs')).data.some((d: any) => d.id === 'guides/plugins'), 'admin-only guide hidden');
  assert.equal((await req('GET', '/api/docs/guides/plugins')).status, 404);
  assert.equal((await req('GET', '/api/connections')).data.length, 0, 'connections are per user');
  assert.equal((await req('GET', `/api/connections/${connId}`)).status, 404);
  cookie = '';
  assert.equal((await req('POST', '/api/auth/login', { username: 'alice', password: 'wrong' })).status, 401);
  assert.equal((await req('POST', '/api/auth/login', { username: 'alice', password: 'alice password' })).status, 200);
  aliceCookie = cookie;
  cookie = adminCookie;
});

test('peers expose read-only shared connections, never connection-management services', async () => {
  const admin = (await req('GET', '/api/me')).data;
  const made = await req('POST', '/api/admin/peers', { name: 'Home PC', ownerUserId: admin.id });
  assert.equal(made.status, 201); const peer = made.data.peer;
  const messages: any[] = []; const waiters: ((m: any) => void)[] = [];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/peers/connect', { headers: { authorization: `Bearer ${made.data.token}`, 'x-switchboard-peer-protocol': '3' } });
  ws.on('message', raw => { const message = JSON.parse(String(raw)); const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>(resolve => waiters.push(resolve));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const welcome = await next(); assert.equal(welcome.protocol, 3);
  ws.send(JSON.stringify({ protocol: 3, type: 'catalog', version: 'test-1', catalog: { instanceId: 'private-machine', connections: [{
    id: 'remote-c1', name: 'family-tree', serviceId: 'family-tree', serviceName: 'Family Tree', kind: 'http', hasOpenapi: true, status: 'ok', route: ['private-machine'], credentials: { secret: 'must-not-copy' }, config: { secret: 'must-not-copy' },
  }] } }));
  assert.equal((await next()).type, 'catalog.accepted');
  const connection = (await req('GET', '/api/connections')).data.find((c: any) => c.peer?.id === peer.id);
  assert.ok(connection); assert.equal(connection.readOnly, true); assert.deepEqual(connection.config, {});
  assert.ok(!(await req('GET', '/api/services')).data.some((s: any) => s.peer));
  const adminCookie = cookie; cookie = aliceCookie;
  assert.ok(!(await req('GET', '/api/connections')).data.some((c: any) => c.peer?.id === peer.id)); cookie = adminCookie;
  for (const [method, p, body] of [
    ['POST', '/api/connections', { service: `peer/${peer.id}/family-tree` }],
    ['POST', `/api/connections/${connection.id}/reconnect`, {}], ['PATCH', `/api/connections/${connection.id}`, { name: 'injected' }], ['DELETE', `/api/connections/${connection.id}`, undefined],
  ] as const) assert.equal((await req(method, p, body)).status, 403);
  const published = await next(); assert.equal(published.type, 'catalog'); assert.deepEqual(published.catalog.connections, []);
  for (const [operation, remoteConnection] of [['call', connId], ['connection.create', connId], ['token', connId]]) {
    ws.send(JSON.stringify({ protocol: 3, type: 'request', requestId: `denied-${operation}`, route: ['private-machine'], deadline: Date.now() + 5000, userId: admin.id, operation, payload: { connection: remoteConnection } }));
    const denial = await next(); assert.equal(denial.type, 'error'); assert.equal(denial.status, 403);
  }
  const calling = req('POST', '/api/call', { connection: connection.id, method: 'GET', url: '/people' });
  const callMessage = await next(); assert.equal(callMessage.operation, 'call'); assert.equal(callMessage.payload.connection, 'remote-c1');
  assert.deepEqual(callMessage.route, [welcome.instanceId]);
  ws.send(JSON.stringify({ protocol: 3, type: 'result', requestId: callMessage.requestId, result: { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: Buffer.from('{"people":2}').toString('base64'), url: 'http://127.0.0.1:9999/people', durationMs: 4, sent: { method: 'GET', url: 'http://127.0.0.1:9999/people', headers: [], authQuery: [], retried: false } } }));
  const called = await calling; assert.equal(called.status, 200, JSON.stringify(called.data)); assert.equal(JSON.parse(called.data.body).people, 2);
  ws.send(JSON.stringify({ protocol: 3, type: 'catalog', catalog: { instanceId: 'different-machine', connections: [] } }));
  assert.equal((await next()).type, 'catalog.rejected');
  await waitFor(async () => !(await req('GET', '/api/admin/peers')).data.find((s: any) => s.id === peer.id).online);
  const offline = await req('POST', '/api/call', { connection: connection.id, method: 'GET', url: '/' });
  assert.equal(offline.status, 503); assert.equal(offline.data.code, 'peer_offline');
  await req('DELETE', `/api/admin/peers/${peer.id}`);
});

// --- MCP ---

let mcpToken = '';
const mcpConn = { id: '', name: 'mcp-api' };

async function rpc(body: any, opts: { token?: string; headers?: Record<string, string>; modern?: boolean } = {}) {
  const modern = opts.modern;
  const msg = { jsonrpc: '2.0', ...body };
  if (modern) {
    msg.params = { ...(msg.params ?? {}), _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}) };
  if (modern) {
    headers['mcp-protocol-version'] = '2026-07-28';
    headers['mcp-method'] = msg.method;
    if (msg.method === 'tools/call') headers['mcp-name'] = msg.params.name;
  }
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...opts.headers }, body: JSON.stringify(msg) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

const toolText = (r: any) => r.data.result.content[0].text as string;

test('MCP: authorization challenge and discovery documents', async () => {
  const r = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  assert.match((await rpc({ id: 1, method: 'ping' }, { token: 'hub_nope' })).headers.get('www-authenticate')!, /error="invalid_token"/);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual([prm.resource, prm.authorization_servers], [`${base}/mcp`, [base]]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer x' } })).status, 405, 'no GET stream');

  // A session cookie is not enough: MCP needs a token.
  assert.equal((await rpc({ id: 1, method: 'ping' }, { headers: { cookie } })).status, 401);
});

test('MCP: legacy initialize, tools and calls through a connection', async () => {
  const c = await req('POST', '/api/connections', { service: 'http', method: 'token', config: { baseUrl: up, token: 'mcp-secret', openapi: `${up}/spec.json` }, name: 'mcp-api' });
  mcpConn.id = c.data.connection.id;
  mcpToken = (await req('POST', '/api/tokens', { name: 'claude-desktop' })).data.secret;

  const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { token: mcpToken });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.ok(init.data.result.capabilities.tools);
  assert.equal(init.headers.get('mcp-session-id'), null, 'stateless');
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);

  const list = await rpc({ id: 2, method: 'tools/list' }, { token: mcpToken, headers: { 'mcp-protocol-version': '2025-06-18' } });
  assert.deepEqual(list.data.result.tools.slice(0, 7).map((t: any) => t.name), ['list_connections', 'search_operations', 'get_operation', 'call', 'call_operation', 'list_saved_calls', 'run_saved_call']);

  const conns = await rpc({ id: 3, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }, { token: mcpToken });
  assert.ok(conns.data.result.structuredContent.items.some((x: any) => x.name === 'mcp-api' && x.hasApiReference && x.location.type === 'local'));

  const found = await rpc({ id: 4, method: 'tools/call', params: { name: 'search_operations', arguments: { connection: 'mcp-api', query: 'thing' } } }, { token: mcpToken });
  assert.deepEqual(found.data.result.structuredContent.operations[0], {
    operationId: 'get /things/{id}', method: 'GET', path: '/api/v2/things/{id}', summary: 'Get a thing',
    parameters: {
      path: [{ name: 'id', in: 'path', required: true }],
      query: [{ name: 'hideCompleted', in: 'query', required: false, type: 'boolean', default: 'false' }, { name: 'nextToken', in: 'query', required: false, type: 'string' }],
      header: [],
    },
    pagination: {
      nextTokenParameter: 'nextToken',
      instruction: "Preserve all filters and pass the response's nextToken value as nextToken on the next call. Continue until the response omits it.",
    },
  });
  const op = await rpc({ id: 5, method: 'tools/call', params: { name: 'get_operation', arguments: { connection: 'mcp-api', method: 'GET', path: '/api/v2/things/{id}' } } }, { token: mcpToken });
  assert.equal(op.data.result.structuredContent.params[0].name, 'id');
  assert.equal(op.data.result.structuredContent.parameters.query[0].default, 'false');
  assert.equal(op.data.result.structuredContent.pagination.nextTokenParameter, 'nextToken');
  assert.equal(op.data.result.structuredContent.callMapping.parameters, 'call_operation.parameters');

  const operationCall = await rpc(
    { id: 51, method: 'tools/call', params: { name: 'call_operation', arguments: { connection: 'mcp-api', operationId: 'get /things/{id}', parameters: { id: 'structured/1', hideCompleted: true } } } },
    { token: mcpToken },
  );
  assert.equal(operationCall.data.result.isError, undefined, JSON.stringify(operationCall.data));
  const operationEcho = JSON.parse(toolText(operationCall).split('\n\n')[1]);
  assert.equal(operationEcho.path, '/api/v2/things/structured/1');
  assert.equal(operationEcho.query.hideCompleted, 'true');
  assert.match(toolText(operationCall), /Pagination:/);
  const invalidOperationCall = await rpc(
    { id: 52, method: 'tools/call', params: { name: 'call_operation', arguments: { connection: 'mcp-api', operationId: 'get /things/{id}', parameters: { id: 'x', unknown: true } } } },
    { token: mcpToken },
  );
  assert.equal(invalidOperationCall.data.result.isError, true);
  assert.match(toolText(invalidOperationCall), /Unknown parameter: unknown/);
  const bodyOperationCall = await rpc(
    { id: 53, method: 'tools/call', params: { name: 'call_operation', arguments: { connection: 'mcp-api', operationId: 'updateThing', parameters: { id: 'body-1', 'x-mode': 'safe' }, body: { title: 'Updated' } } } },
    { token: mcpToken },
  );
  assert.equal(bodyOperationCall.data.result.isError, undefined, JSON.stringify(bodyOperationCall.data));
  assert.equal(seen.at(-1)!.headers['x-mode'], 'safe');
  assert.equal(seen.at(-1)!.headers['content-type'], 'application/json');
  assert.equal(seen.at(-1)!.body, '{"title":"Updated"}');
  const invalidEnum = await rpc(
    { id: 54, method: 'tools/call', params: { name: 'call_operation', arguments: { connection: 'mcp-api', operationId: 'updateThing', parameters: { id: 'body-1', 'x-mode': 'reckless' }, body: {} } } },
    { token: mcpToken },
  );
  assert.equal(invalidEnum.data.result.isError, true);
  assert.match(toolText(invalidEnum), /x-mode must be one of: safe, fast/);

  const called = await rpc(
    { id: 6, method: 'tools/call', params: { name: 'call', arguments: { connection: 'mcp-api', method: 'POST', path: '/api/v2/things/{id}', path_params: { id: 'x/1' }, query: { a: '1' }, body: { hello: 'world' } } } },
    { token: mcpToken },
  );
  assert.equal(called.data.result.isError, undefined);
  assert.match(toolText(called), /^HTTP 200/);
  const echoed = JSON.parse(toolText(called).split('\n\n')[1]);
  assert.equal(echoed.auth, 'Bearer mcp-secret');
  assert.equal(echoed.path, '/api/v2/things/x/1');
  assert.equal(seen.at(-1)!.body, '{"hello":"world"}');
  assert.equal(seen.at(-1)!.headers['content-type'], 'application/json');

  const refused = await rpc({ id: 7, method: 'tools/call', params: { name: 'call', arguments: { connection: 'mcp-api', path: 'https://evil.example/' } } }, { token: mcpToken });
  assert.equal(refused.data.result.isError, true, 'tool errors are results, not protocol errors');
  assert.match(toolText(refused), /not an allowed host/);

  await req('POST', '/api/calls', { name: 'MCP saved', connectionId: mcpConn.id, method: 'GET', url: '/saved', query: [{ key: 'p', value: '1' }] });
  const saved = await rpc({ id: 8, method: 'tools/call', params: { name: 'run_saved_call', arguments: { name: 'MCP saved', query: { p: '2' } } } }, { token: mcpToken });
  assert.equal(JSON.parse(toolText(saved).split('\n\n')[1]).query.p, '2');

  const audit = (await req('GET', `/api/audit?connection=${mcpConn.id}&source=mcp`)).data;
  assert.equal(audit.total, 5);
  assert.equal(audit.items[0].savedCall, 'MCP saved');
  assert.equal(audit.items[0].client.name, 'claude-desktop');
});

test('MCP: pinned SDK negotiates modern and legacy protocols', async () => {
  for (const mode of ['auto', 'legacy'] as const) {
    const client = new Client({ name: 'switchboard-sdk-test', version: '1' }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: async () => mcpToken }, requestInit: { redirect: 'error' },
    });
    try {
      await client.connect(transport, { timeout: 5000 });
      assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      const result = await client.listTools();
      assert.ok(result.tools.some(tool => tool.name === 'list_connections'));
      const connections = await client.callTool({ name: 'list_connections', arguments: {} });
      assert.equal(connections.isError, undefined);
      assert.ok(connections.structuredContent);
    } finally {
      await client.close();
    }
  }
});

test('MCP: modern protocol, header validation and errors', async () => {
  const d = await rpc({ id: 1, method: 'server/discover' }, { token: mcpToken, modern: true });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.result.resultType, 'complete');
  assert.ok(d.data.result.supportedVersions.includes('2026-07-28'));
  assert.equal(d.data.result._meta['io.modelcontextprotocol/serverInfo'].name, 'switchboard');

  const ok = await rpc({ id: 2, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }, { token: mcpToken, modern: true });
  assert.equal(ok.data.result.resultType, 'complete');

  const mismatch = await rpc({ id: 3, method: 'tools/call', params: { name: 'call', arguments: { connection: 'mcp-api', path: '/' } } }, { token: mcpToken, modern: true, headers: { 'mcp-name': 'list_connections' } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.error.code, -32020);
  const b64 = await rpc({ id: 4, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }, { token: mcpToken, modern: true, headers: { 'mcp-name': `=?base64?${Buffer.from('list_connections').toString('base64')}?=` } });
  assert.equal(b64.status, 200, 'base64 sentinel values are decoded');
  const noMethod = await rpc({ id: 5, method: 'tools/list' }, { token: mcpToken, modern: true, headers: { 'mcp-method': 'tools/call' } });
  assert.equal(noMethod.data.error.code, -32020);

  const version = await rpc({ id: 6, method: 'tools/list' }, { token: mcpToken, modern: true, headers: { 'mcp-protocol-version': '2030-01-01' } });
  assert.equal(version.status, 400);
  assert.equal(version.data.error.code, -32020, 'header and _meta disagree');
  const raw = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', 'mcp-protocol-version': '2030-01-01', 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } }),
  });
  const unsupported = await raw.json();
  assert.equal(raw.status, 400);
  assert.equal(unsupported.error.code, -32022);
  assert.ok(unsupported.error.data.supported.includes('2026-07-28'));

  const unknown = await rpc({ id: 8, method: 'resources/subscribe' }, { token: mcpToken, modern: true });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, -32601);

  const evil = await rpc({ id: 9, method: 'ping' }, { token: mcpToken, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('MCP: tokens limited to connections only see and use those', async () => {
  const limited = (await req('POST', '/api/tokens', { name: 'narrow', connectionIds: [connId] })).data.secret;
  const conns = await rpc({ id: 1, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }, { token: limited });
  assert.deepEqual(conns.data.result.structuredContent.items.map((x: any) => x.name), [(await req('GET', `/api/connections/${connId}`)).data.name]);
  const other = await rpc({ id: 2, method: 'tools/call', params: { name: 'call', arguments: { connection: 'mcp-api', path: '/' } } }, { token: limited });
  assert.equal(other.data.result.isError, true);
  assert.match(toolText(other), /may not use/);
  const saved = await rpc({ id: 3, method: 'tools/call', params: { name: 'list_saved_calls', arguments: {} } }, { token: limited });
  assert.ok(!saved.data.result.structuredContent.items.some((x: any) => x.name === 'MCP saved'));
});

async function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

test('MCP: OAuth with dynamic client registration, resource binding and iss', async () => {
  const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: ['http://127.0.0.1:7777/callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.match(client.client_id, /^swbc_/);
  const badReg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://x.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }) });
  assert.equal(badReg.status, 400);

  const { verifier, challenge } = await pkce();
  // Loopback redirect URIs may use any port (RFC 8252).
  const q = { response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:53111/callback', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` };
  const info = await req('GET', `/api/oauth/authorize?${new URLSearchParams(q)}`);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.equal(info.data.client, 'Test Agent');
  assert.equal(info.data.verifiedName, false);
  assert.equal(info.data.forMcp, true);
  assert.equal(info.data.redirectHost, 'an app on your computer');
  assert.equal((await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/callback' })}`)).status, 400);
  assert.equal((await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, resource: 'https://other.example/mcp' })}`)).status, 400);

  const approved = (await req('POST', '/api/oauth/authorize', { ...q, approve: true, connectionIds: [mcpConn.id] })).data;
  const back = new URL(approved.redirect);
  assert.equal(back.searchParams.get('iss'), base, 'RFC 9207 issuer');
  const token = async (extra: Record<string, string> = {}) =>
    fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: client.client_id, redirect_uri: q.redirect_uri, code_verifier: verifier, resource: `${base}/mcp`, ...extra }),
    }).then((r) => r.json());
  const t = await token();
  assert.match(t.access_token, /^swb_/);

  // Bound to the MCP endpoint
  assert.equal((await req('GET', '/api/connections', undefined, { authorization: `Bearer ${t.access_token}` })).status, 401);
  const viaMcp = await rpc({ id: 1, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }, { token: t.access_token });
  assert.deepEqual(viaMcp.data.result.structuredContent.items.map((x: any) => x.name), ['mcp-api']);
  const listed = (await req('GET', '/api/tokens')).data.find((x: any) => x.id === t.token_id);
  assert.equal(listed.name, 'Test Agent (MCP)');
  assert.equal(listed.audience, 'mcp');

  // A second exchange of the same code fails.
  assert.equal((await token()).error, 'invalid_grant');
});

test('MCP: OAuth with a client ID metadata document', async () => {
  const { verifier, challenge } = await pkce();
  const q = { response_type: 'code', client_id: `${up}/client.json`, redirect_uri: 'http://localhost:9000/cb', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` };
  const info = await req('GET', `/api/oauth/authorize?${new URLSearchParams(q)}`);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.equal(info.data.client, 'CIMD App');
  assert.equal(info.data.domain, new URL(up).host, 'shows who vouches for the name');
  assert.equal((await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'http://localhost:9000/other' })}`)).status, 400);
  const forged = await req('GET', `/api/oauth/authorize?${new URLSearchParams({ ...q, client_id: `${up}/forged-client.json` })}`);
  assert.equal(forged.status, 400);
  assert.match(forged.data.error, /different client_id/);

  const back = new URL((await req('POST', '/api/oauth/authorize', { ...q, approve: true })).data.redirect);
  const t = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: q.client_id, redirect_uri: q.redirect_uri, code_verifier: verifier, resource: `${base}/mcp` }) }).then((r) => r.json());
  assert.match(t.access_token, /^swb_/);
  assert.equal((await rpc({ id: 1, method: 'ping' }, { token: t.access_token })).status, 200);
});
