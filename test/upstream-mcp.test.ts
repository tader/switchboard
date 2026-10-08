import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_RESPONSE_LIMIT } from '../server/mcp-network.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-upstream-mcp-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
process.env.SWITCHBOARD_PUBLIC_URL = 'https://switchboard.example';
const database = await import('../server/db.ts');
const { initDb, one, all } = database;
const { initKey, decrypt } = await import('../server/crypto.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const { startConnect, completeRedirect, getConnectionRow, deleteConnection } = await import('../server/connections.ts');
const { createUser, createToken } = await import('../server/users.ts');
const { executeMcp } = await import('../server/upstream-mcp.ts');
const { api } = await import('../server/routes/connections.ts');
const { HttpError } = await import('../server/http.ts');
const { connectionChanged } = await import('../server/connection-events.ts');
initKey(); initDb();
const owner = createUser('owner', 'admin');
const other = createUser('other', 'user');
const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as any : 500));
app.route('/api', api);
app.route('/mcp', (await import('../server/mcp.ts')).mcp);

let base = '';
let refreshes = 0;
let registrations = 0;
let redeemed = 0;
let rejectRefresh = false;
let corruptResource = false;
let metadataClients = false;
let rejectedToken = '';
let badIssuer = false;
let requireExtraScope = false;
let sessionsClosed = 0;
let mutations = 0;
const seen: { path: string; method: string; auth: string | undefined; key: string | undefined; body: any }[] = [];
const capabilities = { tools: {}, resources: {}, prompts: {}, completions: {} };
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url!, base);
  const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
  if (url.pathname.includes('/.well-known/oauth-protected-resource')) return json(200, { resource: corruptResource ? 'https://evil.example/mcp' : `${base}/oauth/mcp`, authorization_servers: [base], scopes_supported: ['tools.read'] });
  if (url.pathname.includes('/.well-known/oauth-authorization-server')) return json(200, {
    issuer: badIssuer ? `${base}/wrong` : base, client_id_metadata_document_supported: metadataClients, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
  });
  if (url.pathname === '/register') { registrations++; return json(201, { ...JSON.parse(raw), client_id: 'registered-client' }); }
  if (url.pathname === '/token') {
    const params = new URLSearchParams(raw);
    assert.equal(params.get('resource'), `${base}/oauth/mcp`);
    if (params.get('grant_type') === 'refresh_token') {
      refreshes++;
      if (rejectRefresh) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: `fresh-${refreshes}`, refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'Bearer' });
    }
    redeemed++;
    assert.ok(params.get('code_verifier'));
    return json(200, { access_token: 'initial-secret', refresh_token: 'refresh-secret', expires_in: 1, token_type: 'Bearer' });
  }
  if (req.method === 'DELETE') { sessionsClosed++; res.writeHead(200); return res.end(); }
  if (req.method === 'GET') { res.writeHead(405); return res.end(); }
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return json(400, {}); }
  seen.push({ path: url.pathname, method: msg.method, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined, body: msg });
  if (url.pathname === '/oauth/mcp' && requireExtraScope && req.headers.authorization?.startsWith('Bearer fresh-')) return json(403, {}, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="tools.write"' });
  if (url.pathname === '/oauth/mcp' && (!req.headers.authorization?.startsWith('Bearer fresh-') || req.headers.authorization === rejectedToken)) return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth/mcp"` });
  if (url.pathname === '/redirect') { res.writeHead(307, { location: `${base}/leak` }); return res.end(); }
  const modern = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
  const reply = (value: any) => {
    const body = { jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...value } : value };
    if (url.pathname === '/sse' && msg.method !== 'server/discover') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`: keepalive\r\n\r\ndata: ${JSON.stringify(body)}\r\n\r\n`);
    }
    return json(200, body, msg.method === 'initialize' ? { 'mcp-session-id': 'scratch-session' } : {});
  };
  const legacy = url.pathname === '/legacy';
  if (msg.method === 'server/discover') {
    if (legacy) return json(404, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    return reply({ supportedVersions: ['2026-07-28'], capabilities: url.pathname === '/no-capabilities' ? {} : capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fake', version: '1' } } });
  }
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-11-25', serverInfo: { name: 'Fake', version: '1' }, capabilities });
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') { res.writeHead(202); return res.end(); }
  const cache = modern ? { ttlMs: 0, cacheScope: 'private' } : {};
  switch (msg.method) {
    case 'tools/list':
      if (url.pathname === '/pages') { const n = Number(msg.params?.cursor ?? '0'); return reply({ ...cache, tools: [{ name: `tool-${n}`, inputSchema: { type: 'object' } }], nextCursor: String(n + 1) }); }
      return reply({ ...cache, tools: [{ name: msg.params?.cursor ? 'second' : 'echo', description: 'Echo a value', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }], ...(msg.params?.cursor ? {} : { nextCursor: 'two' }) });
    case 'tools/call':
      if (msg.params.name === 'expired') { mutations++; return json(404, { error: 'Session expired' }); }
      if (msg.params.name === 'disconnect') { mutations++; return req.socket.destroy(); }
      if (msg.params.name === 'wait') { mutations++; return; }
      if (msg.params.name === 'huge') return reply({ content: [{ type: 'text', text: 'x'.repeat(MCP_RESPONSE_LIMIT + 1) }] });
      if (msg.params.name === 'protocol-error') return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid argument' } });
      return reply({ content: [{ type: 'text', text: 'Echo' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], structuredContent: msg.params.arguments ?? {}, isError: msg.params.name === 'failure' });
    case 'resources/list': return reply({ ...cache, resources: [{ uri: 'file:///notes', name: 'notes', mimeType: 'text/plain' }] });
    case 'resources/templates/list': return reply({ ...cache, resourceTemplates: [{ uriTemplate: 'file:///notes/{id}', name: 'note' }] });
    case 'resources/read': return reply({ ...cache, contents: [{ uri: msg.params.uri, text: 'A note', mimeType: 'text/plain' }, { uri: msg.params.uri, blob: 'aGVsbG8=', mimeType: 'image/png' }] });
    case 'prompts/list': return reply({ ...cache, prompts: [{ name: 'summarize', arguments: [{ name: 'topic', required: true }] }] });
    case 'prompts/get': return reply({ ...cache, messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${msg.params.arguments?.topic}` } }] });
    case 'completion/complete': return reply({ completion: { values: ['alpha', 'alpine'], total: 2, hasMore: false } });
  }
  return json(404, {});
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await plugins.start();
});
after(async () => { await plugins.stop(); server.closeAllConnections(); server.close(); database.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function connect(endpoint: string, method = 'none', config: any = {}) {
  const result = await startConnect(owner, { service: 'mcp', method, config: { endpoint: `${base}${endpoint}`, ...config } });
  if (result.status !== 'connected') throw new Error('Expected direct connection');
  assert.equal(result.connection.kind, 'mcp');
  return result.connection;
}

test('upstream MCP: modern, legacy and SSE preserve tools, resources, prompts and completions', async () => {
  for (const endpoint of ['/modern?exact=1', '/legacy', '/sse']) {
    const conn = await connect(endpoint);
    const list = await executeMcp(owner, conn.id, { operation: 'tools/list' });
    assert.deepEqual(list.tools.map((t: any) => t.name), ['echo', 'second']);
    assert.equal(list.tools[0].annotations.readOnlyHint, false);
    const page = await executeMcp(owner, conn.id, { operation: 'tools/list', cursor: 'two' });
    assert.deepEqual(page.tools.map((t: any) => t.name), ['second']);
    const call = await executeMcp(owner, conn.id, { operation: 'tools/call', name: 'echo', arguments: { value: 'hello' } });
    assert.deepEqual(call.structuredContent, { value: 'hello' });
    assert.equal(call.content[1].type, 'image');
    assert.equal((await executeMcp(owner, conn.id, { operation: 'resources/list' })).resources[0].uri, 'file:///notes');
    assert.equal((await executeMcp(owner, conn.id, { operation: 'resources/templates/list' })).resourceTemplates[0].uriTemplate, 'file:///notes/{id}');
    assert.equal((await executeMcp(owner, conn.id, { operation: 'resources/read', uri: 'file:///notes' })).contents[1].blob, 'aGVsbG8=');
    assert.equal((await executeMcp(owner, conn.id, { operation: 'prompts/list' })).prompts[0].name, 'summarize');
    assert.equal((await executeMcp(owner, conn.id, { operation: 'prompts/get', name: 'summarize', arguments: { topic: 'MCP' } })).messages[0].content.text, 'Summarize MCP');
    assert.deepEqual((await executeMcp(owner, conn.id, { operation: 'completion/complete', ref: { type: 'ref/prompt', name: 'summarize' }, argument: { name: 'topic', value: 'al' } })).completion.values, ['alpha', 'alpine']);
  }
  assert.ok(sessionsClosed >= 9, 'legacy sessions are explicitly terminated');
});

test('upstream MCP: static auth, endpoint checks, connection ownership and token restrictions', async () => {
  const bearer = await connect('/modern', 'token', { token: 'upstream-bearer' });
  const header = await connect('/modern', 'header', { key: 'upstream-key', header: 'X-API-Key' });
  assert.equal(bearer.config.token, undefined);
  assert.equal(header.config.key, undefined);
  const token = createToken(owner.id, 'limited', [bearer.id]).secret;
  const invoke = (id: string, secret = token) => app.request(`/api/connections/${id}/mcp/tools/list`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await invoke(bearer.id)).status, 200);
  assert.equal(seen.at(-1)?.auth, 'Bearer upstream-bearer');
  assert.equal((await invoke(header.id)).status, 403);
  assert.equal((await invoke(bearer.id, createToken(other.id, 'other', null).secret)).status, 404);
  await executeMcp(owner, header.id, { operation: 'tools/list' });
  assert.equal(seen.at(-1)?.key, 'upstream-key');
  assert.ok(!seen.some(r => r.auth === `Bearer ${token}`));
  const redirect = await connect('/redirect', 'token', { token: 'do-not-leak' });
  await assert.rejects(executeMcp(owner, redirect.id, { operation: 'tools/list' }), /redirect/i);
  assert.ok(!seen.some(r => r.path === '/leak'));
  await assert.rejects(connect('/modern', 'header', { key: 'key', header: 'Cookie' }), /reserved/);
  const service = plugins.service('mcp')!;
  service.allowedHosts = ['not-allowed.example'];
  await assert.rejects(executeMcp(owner, bearer.id, { operation: 'tools/list' }), /allowed/);
  delete service.allowedHosts;
  const original = service.authMethods.find(m => m.id === 'token')!.authorize;
  service.authMethods.find(m => m.id === 'token')!.authorize = req => { req.url = new URL('https://not-allowed.example/mcp'); };
  try { await assert.rejects(executeMcp(owner, bearer.id, { operation: 'tools/list' }), /changed/); }
  finally { service.authMethods.find(m => m.id === 'token')!.authorize = original; }
});

test('upstream MCP: failures, bounds, cancellation and lifecycle never replay ambiguous tools', async () => {
  const conn = await connect('/modern');
  assert.equal((await executeMcp(owner, conn.id, { operation: 'tools/call', name: 'failure' })).isError, true);
  await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/call', name: 'protocol-error' }), /Invalid argument/);
  await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/call', name: 'huge' }), /size limit|fetch|stream|closed/i);
  const pages = await connect('/pages');
  await assert.rejects(executeMcp(owner, pages.id, { operation: 'tools/list' }), /page|pagination/i);
  const expiryBefore = mutations;
  await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/call', name: 'expired' }), /404|expired/i);
  assert.equal(mutations, expiryBefore + 1);
  const previous = mutations;
  await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/call', name: 'disconnect' }), /failed/i);
  assert.equal(mutations, previous + 1);
  const abort = new AbortController();
  const pending = executeMcp(owner, conn.id, { operation: 'tools/call', name: 'wait' }, abort.signal);
  while (mutations < previous + 2) await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  const another = executeMcp(owner, conn.id, { operation: 'tools/call', name: 'wait' });
  while (mutations < previous + 3) await new Promise(resolve => setTimeout(resolve, 10));
  connectionChanged(conn.id);
  await assert.rejects(another, /cancelled/);
  const unsupported = await connect('/no-capabilities');
  await assert.rejects(executeMcp(owner, unsupported.id, { operation: 'resources/list' }), /does not support/i);
});

test('upstream MCP OAuth: discovery, encrypted state, PKCE, issuer and serialized refresh', async () => {
  const start = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } });
  assert.equal(start.status, 'redirect');
  if (start.status !== 'redirect') throw new Error('Expected OAuth redirect');
  const url = new URL(start.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), `${base}/oauth/mcp`);
  assert.equal(url.searchParams.get('state'), start.flowId);
  assert.equal(registrations, 1);
  const flow = one('SELECT * FROM connect_flows WHERE id = ?', start.flowId);
  assert.ok(!flow.pending_enc.includes('codeVerifier'));
  const conn = await completeRedirect(start.flowId, { state: start.flowId, code: 'good', iss: base }, owner);
  assert.equal(redeemed, 1);
  const stored = getConnectionRow(owner.id, conn.id);
  assert.ok(!stored.credentials_enc.includes('initial-secret'));
  assert.equal(decrypt(stored.credentials_enc).tokens.access_token, 'initial-secret');
  await Promise.all([executeMcp(owner, conn.id, { operation: 'tools/list' }), executeMcp(owner, conn.id, { operation: 'resources/list' })]);
  assert.equal(refreshes, 1);
  rejectedToken = 'Bearer fresh-1';
  await Promise.all([executeMcp(owner, conn.id, { operation: 'tools/list' }), executeMcp(owner, conn.id, { operation: 'resources/list' })]);
  assert.equal(refreshes, 2, 'concurrent 401s use one refreshed token');
  rejectedToken = '';
  const denied = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } });
  if (denied.status !== 'redirect') throw new Error('Expected redirect');
  await assert.rejects(completeRedirect(denied.flowId, { state: denied.flowId, code: 'good', iss: 'https://evil.example' }, owner), /issuer/i);
  assert.equal(redeemed, 1, 'issuer mismatch never redeems a code');
  const deniedConsent = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } });
  if (deniedConsent.status !== 'redirect') throw new Error('Expected redirect');
  await assert.rejects(completeRedirect(deniedConsent.flowId, { state: deniedConsent.flowId, error: 'access_denied', iss: base }, owner), /declined/);
  corruptResource = true;
  await assert.rejects(startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } }), /resource/);
  corruptResource = false;
  const creds = decrypt(getConnectionRow(owner.id, conn.id).credentials_enc);
  creds.expiresAt = 1;
  const { saveCredentials } = await import('../server/connections.ts');
  saveCredentials(conn.id, creds);
  rejectRefresh = true;
  await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/list' }), /Reconnect/);
  rejectRefresh = false;
  await deleteConnection(owner.id, conn.id);
});

test('upstream MCP: audit redacts arguments, flags tool errors, and stores no result bodies', async () => {
  const conn = await connect('/modern', 'token', { token: 'private-token' });
  const secret = createToken(owner.id, 'audit-test', null).secret;
  const response = await app.request(`/api/connections/${conn.id}/mcp/tools/call`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'failure', arguments: { password: 'do-not-store', token: 'do-not-store', pageToken: 'visible' } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).isError, true);
  const rows = all('SELECT * FROM audit_log WHERE connection_id = ?', conn.id);
  assert.equal(rows[0].status, 502);
  assert.equal(rows[0].mcp_operation, 'tools/call');
  assert.equal(rows[0].mcp_target, 'failure');
  assert.equal(rows[0].mcp_outcome, 'tool-error');
  assert.ok(rows[0].request_body.includes('visible'));
  assert.ok(!JSON.stringify(rows).includes('do-not-store'));
  assert.ok(!JSON.stringify(rows).includes('private-token'));
  assert.ok(!JSON.stringify(rows).includes('aGVsbG8='));
});


test('upstream MCP OAuth: metadata clients, pre-registration and unsafe discovery', async () => {
  metadataClients = true;
  const beforeRegistration = registrations;
  const result = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } });
  if (result.status !== 'redirect') throw new Error('Expected redirect');
  assert.equal(new URL(result.url).searchParams.get('client_id'), 'https://switchboard.example/oauth/mcp-client-metadata');
  assert.equal(registrations, beforeRegistration);
  await completeRedirect(result.flowId, { state: result.flowId, code: 'good', iss: base }, owner);
  metadataClients = false;
  const registered = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp`, clientId: 'pre-registered', issuer: base } });
  if (registered.status !== 'redirect') throw new Error('Expected redirect');
  assert.equal(new URL(registered.url).searchParams.get('client_id'), 'pre-registered');
  assert.equal(registrations, beforeRegistration);
  await assert.rejects(startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp`, clientId: 'pre-registered', issuer: `${base}/another` } }), /issuer/);
  badIssuer = true;
  await assert.rejects(startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } }), /issuer/i);
  badIssuer = false;
  const { validateOAuthUrl, mcpEndpoint } = await import('../server/mcp-network.ts');
  for (const uri of ['https://127.0.0.1/metadata', 'https://[::ffff:7f00:1]/metadata', 'https://192.168.0.1/metadata', 'http://oauth.example/token', 'file:///etc/passwd']) {
    await assert.rejects(validateOAuthUrl(uri, mcpEndpoint('https://mcp.example/mcp')), /private|HTTPS|HTTP/i);
  }
  await validateOAuthUrl('https://127.0.0.1/metadata', mcpEndpoint('https://mcp.example/mcp'), true);
});


test('upstream MCP: saved requests and native federation preserve namespaces and enforce access', async () => {
  const conn = await connect('/modern');
  const second = await connect('/legacy');
  const full = createToken(owner.id, 'full', null).secret;
  const restricted = createToken(owner.id, 'native', [conn.id]).secret;
  const request = (pathname: string, body: any, secret = full) => app.request(`/api${pathname}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const inspected = await request(`/connections/${conn.id}/mcp/tools/get`, { name: 'echo' }, restricted);
  assert.equal((await inspected.json()).inputSchema.type, 'object');
  assert.equal((await request(`/connections/${conn.id}/mcp/tools/get`, { name: 'missing' }, restricted)).status, 404);
  const saved = await request('/calls', { kind: 'mcp', name: 'saved-echo', connectionId: conn.id, mcpRequest: { operation: 'tools/call', name: 'echo', arguments: { original: true } } });
  assert.equal(saved.status, 201);
  const call = await saved.json();
  assert.equal(call.kind, 'mcp');
  const replay = await request(`/calls/${call.id}/run`, { arguments: { extra: true } }, restricted);
  assert.deepEqual((await replay.json()).structuredContent, { original: true, extra: true });
  assert.equal((await request('/calls', { kind: 'http', name: 'wrong-protocol', connectionId: conn.id })).status, 400);
  const denied = createToken(owner.id, 'excluded', [second.id]).secret;
  assert.equal((await request(`/calls/${call.id}/run`, {}, denied)).status, 404);
  assert.equal((await request(`/calls/${call.id}/run`, {}, createToken(other.id, 'stranger', null).secret)).status, 404);
  for (const mode of ['auto', 'legacy'] as const) {
    const client = new Client({ name: 'federation-test', version: '1' }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://switchboard.example/mcp'), { requestInit: { headers: { authorization: `Bearer ${restricted}` } }, fetch: async (url, init) => app.request(String(url), init) }));
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some(t => t.name === 'get_mcp_tool'));
      const resources = await client.listResources();
      assert.equal(resources.resources.length, 1);
      const uri = `switchboard-mcp:${conn.id}:file:///notes`;
      assert.equal(resources.resources[0].uri, uri);
      assert.equal((await client.readResource({ uri })).contents[0].uri, uri);
      const template = (await client.listResourceTemplates()).resourceTemplates[0];
      assert.equal(template.uriTemplate, `switchboard-mcp:${conn.id}:file:///notes/{id}`);
      const prompts = await client.listPrompts();
      assert.equal(prompts.prompts[0].name, `${conn.id}:summarize`);
      const prompt = await client.getPrompt({ name: prompts.prompts[0].name, arguments: { topic: 'federation' } });
      assert.equal(prompt.messages[0].role, 'user');
      assert.equal((await client.complete({ ref: { type: 'ref/prompt', name: prompts.prompts[0].name }, argument: { name: 'topic', value: 'al' } })).completion.values[0], 'alpha');
      const rich = await client.callTool({ name: 'call_mcp_tool', arguments: { connection: conn.id, name: 'failure', arguments: { value: 1 } } });
      assert.equal(rich.isError, true);
      assert.equal(rich.content[1].type, 'image');
      const replay = await client.callTool({ name: 'run_saved_call', arguments: { name: call.id, arguments: { native: true } } });
      assert.deepEqual(replay.structuredContent, { original: true, native: true });
      await assert.rejects(client.readResource({ uri: `switchboard-mcp:${second.id}:file:///notes` }), /cannot|may not|not shared/i);
      assert.equal((await client.callTool({ name: 'call_mcp_tool', arguments: { connection: second.id, name: 'echo' } })).isError, true);
    } finally { await client.close(); }
  }
});

test('upstream MCP OAuth: insufficient scope requires reconnect and renews requested consent', async () => {
  const start = await startConnect(owner, { service: 'mcp', method: 'oauth', config: { endpoint: `${base}/oauth/mcp` } });
  if (start.status !== 'redirect') throw new Error('Expected redirect');
  const conn = await completeRedirect(start.flowId, { state: start.flowId, code: 'good', iss: base }, owner);
  await executeMcp(owner, conn.id, { operation: 'tools/list' });
  requireExtraScope = true;
  try {
    await assert.rejects(executeMcp(owner, conn.id, { operation: 'tools/call', name: 'echo' }), /additional scopes/);
    assert.equal(decrypt(getConnectionRow(owner.id, conn.id).credentials_enc).requiredScope, 'tools.write');
    const renew = await startConnect(owner, { service: 'mcp', connection: conn.id, config: conn.config });
    if (renew.status !== 'redirect') throw new Error('Expected consent redirect');
    assert.ok(new URL(renew.url).searchParams.get('scope')?.includes('tools.write'));
  } finally { requireExtraScope = false; }
});
