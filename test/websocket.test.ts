import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { Hono } from 'hono';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-websocket-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
process.env.SWITCHBOARD_PUBLIC_URL = 'http://switchboard.example';
const database = await import('../server/db.ts');
const { initDb, one, all, run } = database;
const { initKey } = await import('../server/crypto.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const { startConnect, saveCredentials } = await import('../server/connections.ts');
const { createUser, createToken, updateToken, deleteToken, createSession, deleteSession } = await import('../server/users.ts');
const { api } = await import('../server/routes/connections.ts');
const { mcp } = await import('../server/mcp.ts');
const { HttpError } = await import('../server/http.ts');
const { connectionChanged } = await import('../server/connection-events.ts');
const { stopWebSockets } = await import('../server/websocket-transport.ts');
const { stopWebSocketSubscriptions } = await import('../server/websocket.ts');
const { validateWebSocketCapability } = await import('../server/websocket-schema.ts');
initKey(); initDb();
const user = createUser('owner', 'admin');
const other = createUser('other', 'user');
const full = createToken(user.id, 'full', null);
const app = new Hono();
app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status as any : 500));
app.route('/api', api); app.route('/mcp', mcp);
const upstream = http.createServer();
const wss = new WebSocketServer({ noServer: true });
let base = '';
let opened = 0;
let mutations = 0;
let stopped = 0;
upstream.on('upgrade', (req, socket, head) => {
  if (req.url?.includes('header') && req.headers.authorization !== 'Bearer upstream-secret') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    opened++;
    let authenticated = !req.url?.includes('message');
    if (!authenticated) ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (!authenticated) {
        authenticated = msg.access_token === 'upstream-secret';
        ws.send(JSON.stringify({ type: authenticated ? 'auth_ok' : 'auth_invalid' }));
        if (!authenticated) ws.close();
        return;
      }
      if (msg.type === 'wait') { mutations++; return; }
      if (msg.type === 'stop') stopped++;
      ws.send(JSON.stringify({ id: msg.id, type: 'result', result: { value: msg.value ?? 'ok' } }));
      if (msg.type === 'watch') {
        let i = 0;
        const send = () => {
          for (let count = 0; count < 50 && i < (msg.count ?? 1); count++, i++) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, type: 'event', event: { value: msg.payload === 'oversized' ? 'x'.repeat(256 * 1024) : msg.payload ?? String(i) } }));
          }
          if (i < (msg.count ?? 1) && ws.readyState === WebSocket.OPEN) setTimeout(send, 2);
        };
        send();
      }
    });
  });
});
before(async () => {
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/websocket-plugin'), path.join(dir, 'plugins/websocket-test'), { recursive: true });
  await plugins.start();
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(async () => { stopWebSocketSubscriptions(); stopWebSockets(); for (const ws of wss.clients) ws.terminate(); wss.close(); upstream.close(); await plugins.stop(); database.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function connect(method = 'message', token = 'upstream-secret') {
  const result = await startConnect(user, { service: 'websocket-test', method, config: { endpoint: base, token } });
  if (result.status !== 'connected') throw new Error('Expected connection');
  return result.connection;
}
async function request(route: string, body?: unknown, secret = full.secret, method?: string) {
  const response = await app.request(`/api${route}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const root = (id: string) => `/connections/${id}/websocket`;

test('real WebSockets: discovery, message/header authentication, refresh, reuse and schema validation', async () => {
  for (const method of ['message', 'header']) {
    const conn = await connect(method, 'expired');
    assert.equal(conn.hasWebSocket, true); assert.equal(conn.config.token, undefined);
    const endpoint = root(conn.id);
    const found = await request(`${endpoint}/operations?query=echo&limit=1`);
    assert.equal(found.data.operations[0].id, 'echo/value');
    assert.equal((await request(`${endpoint}/operations/${encodeURIComponent('echo/value')}`)).data.operation.mode, 'command');
    const before = opened;
    assert.equal((await request(`${endpoint}/call`, { operationId: 'echo/value', arguments: { value: method } })).data.result.value, method);
    assert.equal((await request(`${endpoint}/call`, { operationId: 'echo/value', arguments: { value: 'again' } })).data.result.value, 'again');
    assert.equal(opened - before, method === 'message' ? 2 : 1);
    assert.equal((await request(`${endpoint}/call`, { operationId: 'echo/value', arguments: { value: 3 } })).status, 400);
    assert.equal((await request(`${endpoint}/call`, { operationId: 'bad', arguments: {} })).status, 502);
    assert.equal((await request(`${endpoint}/call`, { operationId: 'watch', arguments: {} })).status, 400);
  }
});
test('scoped tokens, caller isolation, same-origin cookies and MCP token audiences', async () => {
  const conn = await connect(); const denied = createToken(user.id, 'denied', []);
  assert.equal((await request(`${root(conn.id)}/call`, { operationId: 'echo/value', arguments: { value: 'x' } }, denied.secret)).status, 403);
  assert.equal((await request(`${root(conn.id)}/operations`, undefined, createToken(other.id, 'other', null).secret)).status, 404);
  const audience = createToken(user.id, 'mcp', [conn.id], null, { audience: 'mcp' });
  assert.equal((await request(`${root(conn.id)}/operations`, undefined, audience.secret)).status, 401);
  const before = opened;
  for (const secret of [full.secret, createToken(user.id, 'separate', [conn.id]).secret]) assert.equal((await request(`${root(conn.id)}/call`, { operationId: 'echo/value', arguments: { value: 'x' } }, secret)).status, 200);
  assert.equal(opened - before, 2);
  const cookie = `switchboard_session=${createSession(user.id)}`;
  const response = await app.request(`/api${root(conn.id)}/call`, { method: 'POST', headers: { cookie, origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'echo/value', arguments: { value: 'x' } }) });
  assert.equal(response.status, 403);
});
test('subscriptions acknowledge, replay cursors, long poll, stop and retain terminal events', async () => {
  const conn = await connect(); const endpoint = root(conn.id);
  const created = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 4 } });
  assert.equal(created.status, 200); const id = created.data.id;
  const first = await request(`${endpoint}/subscriptions/${id}/read`, { limit: 2, waitMs: 1000 });
  assert.ok(first.data.events.length > 0 && first.data.events.length <= 2); assert.equal(first.data.nextCursor, first.data.events.length);
  const replay = await request(`${endpoint}/subscriptions/${id}/read`, { limit: first.data.events.length }); assert.deepEqual(replay.data.events, first.data.events);
  let cursor = first.data.nextCursor;
  while (cursor < 4) { const next = await request(`${endpoint}/subscriptions/${id}/read`, { cursor, waitMs: 1000 }); assert.ok(next.data.events.length); cursor = next.data.nextCursor; }
  assert.equal((await request(`${endpoint}/subscriptions/${id}/read`, {}, createToken(user.id, 'wrong-handle', [conn.id]).secret)).status, 404);
  assert.equal((await request(`${endpoint}/subscriptions/${id}/read`, { cursor: 100 })).status, 400);
  const prior = stopped; const ended = await request(`${endpoint}/subscriptions/${id}`, undefined, full.secret, 'DELETE'); assert.equal(ended.data.status, 'stopped');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, prior + 1);
  assert.equal((await request(`${endpoint}/subscriptions/${id}/read`, {})).data.events.length, 4);
  assert.equal((await request(`${endpoint}/subscriptions/${id}`, undefined, full.secret, 'DELETE')).status, 200);
});
test('bounded buffers report overflow, oversized events stop collection, and revocation removes handles', async () => {
  const conn = await connect(); const endpoint = root(conn.id);
  const created = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 1100 } });
  await new Promise(resolve => setTimeout(resolve, 150));
  const page = await request(`${endpoint}/subscriptions/${created.data.id}/read`, {});
  assert.ok(page.data.gap.to >= 100); assert.equal(page.data.events.length, 100);
  const large = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { payload: 'x'.repeat(256 * 1024) } });
  assert.equal(large.status, 413);
  const restricted = createToken(user.id, 'revocable', [conn.id]);
  const lease = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 0 } }, restricted.secret);
  updateToken(user.id, restricted.token.id, { connectionIds: [] });
  updateToken(user.id, restricted.token.id, { connectionIds: [conn.id] });
  assert.equal((await request(`${endpoint}/subscriptions/${lease.data.id}/read`, {}, restricted.secret)).status, 404);
  const lease2 = await request(`${endpoint}/subscriptions`, { operationId: 'watch' }, restricted.secret);
  deleteToken(user.id, restricted.token.id); assert.equal((await request(`${endpoint}/subscriptions/${lease2.data.id}/read`, {}, restricted.secret)).status, 401);
});
test('credential replacement and connection changes stop sessions and preserve buffered events', async () => {
  const conn = await connect(); const endpoint = root(conn.id);
  const lease = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 2 } });
  await new Promise(resolve => setTimeout(resolve, 10)); saveCredentials(conn.id, { token: 'upstream-secret' });
  const page = await request(`${endpoint}/subscriptions/${lease.data.id}/read`, {});
  assert.equal(page.data.status, 'interrupted'); assert.equal(page.data.events.length, 2);
  const second = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 0 } });
  connectionChanged(conn.id); assert.equal((await request(`${endpoint}/subscriptions/${second.data.id}/read`, {})).data.status, 'interrupted');
});
test('cancelled commands are sent once, close their session, and release resources', async () => {
  const conn = await connect(); const controller = new AbortController();
  const before = mutations;
  const pending = app.request(`/api${root(conn.id)}/call`, { method: 'POST', headers: { authorization: `Bearer ${full.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'wait', arguments: {} }), signal: controller.signal });
  while (mutations === before) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); assert.equal((await pending).status, 499); assert.equal(mutations, before + 1);
  assert.equal((await request(`${root(conn.id)}/call`, { operationId: 'echo/value', arguments: { value: 'after' } })).status, 200);
});
test('saved WebSocket commands validate and run; audit records redact arguments and omit results', async () => {
  const conn = await connect();
  const saved = await request('/calls', { name: 'echo command', connectionId: conn.id, kind: 'websocket', websocketRequest: { operationId: 'echo/value', arguments: { value: 'result-only', access_token: 'argument-secret' } } });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal((await request(`/calls/${saved.data.id}/run`, { arguments: { value: 'overridden' } })).data.result.value, 'overridden');
  assert.equal((await request('/calls', { name: 'invalid', connectionId: conn.id, kind: 'websocket', websocketRequest: { operationId: 'watch', arguments: {} } })).status, 400);
  const rows = all('SELECT * FROM audit_log WHERE method = ?', 'WS');
  assert.ok(rows.length); assert.ok(!JSON.stringify(rows).includes('upstream-secret')); assert.ok(!JSON.stringify(rows).includes('argument-secret'));
  assert.ok(rows.some(r => r.ws_operation === 'call' && r.ws_target === 'echo/value' && r.ws_outcome === 'success'));
  assert.equal((await request('/audit?q=echo')).status, 200);
  assert.equal(one('SELECT kind FROM saved_calls WHERE id = ?', saved.data.id).kind, 'websocket');
});
test('MCP clients discover operations, execute structured results, and manage subscriptions on modern and legacy protocols', async () => {
  const conn = await connect();
  for (const version of ['2026-07-28', '2025-11-25']) {
    const secret = createToken(user.id, version, [conn.id], null, { audience: 'mcp' }).secret;
    const client = new Client({ name: 'ws-test', version: '1' }, { versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } });
    const transport = new StreamableHTTPClientTransport(new URL('http://switchboard.example/mcp'), { requestInit: { headers: { authorization: `Bearer ${secret}` } }, fetch: async (url, init) => app.request(String(url), init as any) });
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), version === '2026-07-28' ? 'modern' : 'legacy');
    const listing = await client.listTools(); assert.ok(listing.tools.some(t => t.name === 'call_websocket_operation'));
    const result = await client.callTool({ name: 'call_websocket_operation', arguments: { connection: conn.id, operationId: 'echo/value', arguments: { value: version } } });
    assert.equal((result.structuredContent as any).result.value, version);
    const sub = await client.callTool({ name: 'subscribe_websocket', arguments: { connection: conn.id, operationId: 'watch', arguments: { count: 1 } } });
    const id = (sub.structuredContent as any).id;
    const page = await client.callTool({ name: 'read_websocket_events', arguments: { connection: conn.id, subscriptionId: id, waitMs: 1000 } });
    assert.equal((page.structuredContent as any).events.length, 1);
    assert.equal((await client.callTool({ name: 'unsubscribe_websocket', arguments: { connection: conn.id, subscriptionId: id } })).isError, undefined);
    await client.close();
  }
});
test('schema registration rejects duplicate ids and unresolved external references', () => {
  const capability = plugins.service('websocket-test')!.websocket!;
  assert.throws(() => validateWebSocketCapability({ ...capability, operations: [capability.operations[0], capability.operations[0]] }));
  assert.throws(() => validateWebSocketCapability({ ...capability, operations: [{ ...capability.operations[0], inputSchema: { type: 'object', properties: { value: { $ref: 'https://outside.example/schema' } } } }] }));
});

test('lease expiry, retention, principal quotas and session logout release subscriptions', async t => {
  const conn = await connect(); const endpoint = root(conn.id);
  const caller = createToken(user.id, 'quota', [conn.id]);
  const handles: string[] = [];
  for (let i = 0; i < 8; i++) {
    const result = await request(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 0 } }, caller.secret);
    assert.equal(result.status, 200, JSON.stringify(result.data)); handles.push(result.data.id);
  }
  assert.equal((await request(`${endpoint}/subscriptions`, { operationId: 'watch' }, caller.secret)).status, 429);
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  try {
    t.mock.timers.setTime(now + 300001);
    const expired = await request(`${endpoint}/subscriptions/${handles[0]}/read`, {}, caller.secret); assert.equal(expired.data.status, 'expired');
    t.mock.timers.setTime(now + 600002);
    assert.equal((await request(`${endpoint}/subscriptions/${handles[0]}/read`, {}, caller.secret)).status, 404);
  } finally { t.mock.timers.reset(); }
  deleteToken(user.id, caller.token.id);
  const session = createSession(user.id);
  const cookieRequest = (path: string, body: unknown) => app.request(`/api${path}`, { method: 'POST', headers: { cookie: `switchboard_session=${session}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await cookieRequest(`${endpoint}/subscriptions`, { operationId: 'watch', arguments: { count: 0 } }); assert.equal(response.status, 200);
  const handle = (await response.json() as any).id;
  deleteSession(session); assert.equal((await cookieRequest(`${endpoint}/subscriptions/${handle}/read`, {})).status, 401);
});

test('endpoints and post-authorization host changes are checked before sending credentials', async () => {
  const conn = await connect(); const service = plugins.service('websocket-test')!;
  const endpoint = service.websocket!.endpoint;
  const authorize = service.authMethods.find(m => m.id === 'message')!.authorize;
  const before = opened;
  try {
    service.websocket!.endpoint = 'wss://forbidden.example/socket';
    assert.equal((await request(`${root(conn.id)}/call`, { operationId: 'echo/value', arguments: { value: 'x' } })).status, 400);
    service.websocket!.endpoint = endpoint;
    service.authMethods.find(m => m.id === 'message')!.authorize = req => { req.url = new URL('https://forbidden.example/socket'); };
    assert.equal((await request(`${root(conn.id)}/call`, { operationId: 'echo/value', arguments: { value: 'x' } })).status, 400);
    assert.equal(opened, before);
  } finally { service.websocket!.endpoint = endpoint; service.authMethods.find(m => m.id === 'message')!.authorize = authorize; }
});
