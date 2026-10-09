import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { installFixturePlugins } from './plugin-fixtures.ts';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-peer-'));
const processes: ChildProcess[] = [];
let provider: http.Server | undefined;

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 12_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timeout');
};

function launch(port: number, dataDir: string, extra: Record<string, string> = {}) {
  installFixturePlugins(dataDir, ['shell-command']);
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], {
    cwd: root,
    env: { ...process.env, SWITCHBOARD_PORT: String(port), SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_WATCH_PLUGINS: 'false', ...extra },
  });
  child.stdout!.on('data', (d) => output += d);
  child.stderr!.on('data', (d) => output += d);
  processes.push(child);
  return { child, output: () => output };
}

after(() => {
  for (const child of processes) child.kill();
  provider?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

let waitingMcp = false;

test('a real peer keeps credentials local and executes a per-user connection', async () => {
  provider = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/mcp') {
      const msg = JSON.parse(body);
      assert.equal(request.headers.authorization, 'Bearer peer-mcp-secret');
      if (msg.method === 'tools/call' && msg.params.name === 'wait') { waitingMcp = true; return; }
      const modern = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
      const result = msg.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Peer MCP', version: '1' } } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }], ttlMs: 0, cacheScope: 'private' }
        : msg.method === 'resources/list' ? { resources: [{ name: 'notes', uri: 'file:///peer-notes' }], ttlMs: 0, cacheScope: 'private' }
        : msg.method === 'resources/read' ? { contents: [{ uri: msg.params.uri, text: 'Peer note' }], ttlMs: 0, cacheScope: 'private' }
        : { content: [{ type: 'text', text: 'Peer MCP result' }], structuredContent: msg.params.arguments };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ...(modern ? { resultType: 'complete' } : {}), ...result } }));
      return;
    }
    if (request.url === '/spec.json') {
      response.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Peer test', version: '1' }, paths: { '/local': { post: { operationId: 'localCall', summary: 'Call the local API', responses: { 200: { description: 'OK' } } } } } }));
      return;
    }
    response.end(JSON.stringify({ path: request.url, auth: request.headers.authorization, body }));
  });
  await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
  const peerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  const centralPort = 31000 + Math.floor(Math.random() * 2000);
  const peerPort = centralPort + 3000;
  const centralUrl = `http://127.0.0.1:${centralPort}`;
  const centralDir = path.join(scratch, 'central');
  const peerDir = path.join(scratch, 'peer');
  const central = launch(centralPort, centralDir);
  await waitFor(() => central.output().includes('Switchboard listening'));

  let cookie = '';
  const request = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(centralUrl + pathname, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };

  const invitation = central.output().match(/\/invite#(\S+)/)?.[1];
  assert.ok(invitation, central.output());
  assert.equal((await request('POST', '/api/auth/invite', { token: invitation, password: 'central password' })).status, 200);
  const me = (await request('GET', '/api/me')).data;
  const enrolled = await request('POST', '/api/admin/peers', { name: 'Test laptop', ownerUserId: me.id });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));

  const peer = launch(peerPort, peerDir, {
    SWITCHBOARD_PEER_URL: centralUrl,
    SWITCHBOARD_PEER_TOKEN: enrolled.data.token,
  });
  await waitFor(() => peer.output().includes('Switchboard listening'));
  let peerCookie = '';
  const peerRequest = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${peerPort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(peerCookie ? { cookie: peerCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) peerCookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const peerInvitation = peer.output().match(/\/invite#(\S+)/)?.[1];
  assert.ok(peerInvitation, peer.output());
  assert.equal((await peerRequest('POST', '/api/auth/invite', { token: peerInvitation, password: 'peer password' })).status, 200);
  assert.equal((await peerRequest('PUT', '/api/admin/plugins/shell-command/settings', { enabled: true })).status, 200);
  await waitFor(async () => (await request('GET', '/api/admin/peers')).data[0]?.online === true);
  const peerState = await peerRequest('GET', '/api/admin/peers');
  assert.equal(peerState.data.length, 1);
  assert.equal(peerState.data[0].state, 'online');
  assert.equal(peerState.data[0].url, centralUrl);
  assert.equal(peerState.data[0].token, undefined);
  const peerId = peerState.data[0].id;
  assert.equal((await request('GET', '/api/admin/peers')).data.length, 1);
  assert.ok(!(await request('GET', '/api/services')).data.some((s: any) => s.peer), 'peer cannot create peer connections');
  const forbidden = await request('POST', '/api/connections', { service: `peer/${enrolled.data.peer.id}/http`, method: 'token', config: { token: 'injected' } });
  assert.equal(forbidden.status, 403);

  const local = await peerRequest('POST', '/api/connections', { service: 'http', method: 'token', name: 'shared-api',
    config: { baseUrl: peerUrl, token: 'peer-only-secret', label: 'Private local API', openapi: `${peerUrl}/spec.json` } });
  assert.equal(local.status, 200, JSON.stringify(local.data));
  assert.equal((await request('GET', '/api/connections')).data.length, 0, 'creation does not implicitly share');
  assert.equal((await peerRequest('PUT', `/api/connections/${local.data.connection.id}/shares`, { peerIds: [peerId] })).status, 200);
  await waitFor(async () => (await request('GET', '/api/connections')).data.some((c: any) => c.name === 'shared-api'));
  const connected = { data: { connection: (await request('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-api') } };
  assert.equal(connected.data.connection.readOnly, true);
  assert.deepEqual(connected.data.connection.config, {});
  assert.equal(connected.data.connection.account, null);
  for (const [method, suffix, body] of [['PATCH', '', { name: 'injected' }], ['POST', '/reconnect', {}], ['DELETE', '', undefined]] as const) {
    assert.equal((await request(method, `/api/connections/${connected.data.connection.id}${suffix}`, body)).status, 403);
  }
  const called = await request('POST', '/api/call', { connection: connected.data.connection.id, method: 'POST', url: '/local', body: 'hello' });
  assert.equal(called.status, 200, JSON.stringify(called.data));
  const result = JSON.parse(called.data.body);
  assert.equal(result.path, '/local');
  assert.equal(result.auth, 'Bearer peer-only-secret');
  assert.equal(result.body, 'hello');

  const peerAudit = await peerRequest('GET', '/api/audit');
  assert.equal(peerAudit.status, 200);
  assert.equal(peerAudit.data.total, 1, JSON.stringify(peerAudit.data));
  assert.equal(peerAudit.data.items[0].connection.name, connected.data.connection.name);
  assert.equal(peerAudit.data.items[0].client.name, 'Peer: Web console');
  assert.equal(peerAudit.data.items[0].source, 'console');
  assert.equal(peerAudit.data.items[0].status, 200);
  assert.equal(peerAudit.data.items[0].peer.id, peerId);
  assert.equal(peerAudit.data.items[0].peer.userId, me.id);
  assert.ok(peerAudit.data.items[0].responseSize > 0);
  const peerFacets = await peerRequest('GET', '/api/audit/facets');
  assert.equal(peerFacets.data.connections[0].count, 1);
  assert.equal(peerFacets.data.clients[0].name, 'Peer: Web console');

  const mcpToken = (await request('POST', '/api/tokens', { name: 'Peer MCP test' })).data.secret;
  const mcp = async (name: string, args: any) => {
    const response = await fetch(`${centralUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return response.json();
  };
  const mcpConnections = await mcp('list_connections', {});
  const mcpRemote = mcpConnections.result.structuredContent.items.find((item: any) => item.name === connected.data.connection.name);
  assert.deepEqual(mcpRemote.location, { type: 'peer', name: 'Test laptop', online: true });
  const operations = await mcp('search_operations', { connection: connected.data.connection.name, query: 'local' });
  assert.equal(operations.result.isError, undefined, JSON.stringify(operations));
  assert.deepEqual(operations.result.structuredContent.operations[0], {
    operationId: 'localCall', method: 'POST', path: '/local', summary: 'Call the local API',
    parameters: { path: [], query: [], header: [] },
  });
  const mcpCall = await mcp('call_operation', { connection: connected.data.connection.name, operationId: 'localCall' });
  assert.equal(mcpCall.result.isError, undefined, JSON.stringify(mcpCall));
  assert.match(mcpCall.result.content[0].text, /^HTTP 200/);
  const peerMcpAudit = await peerRequest('GET', '/api/audit?source=mcp');
  assert.equal(peerMcpAudit.data.total, 1);
  assert.equal(peerMcpAudit.data.items[0].client.name, 'Peer: Peer MCP test');

  const localMcp = await peerRequest('POST', '/api/connections', { service: 'mcp', method: 'token', name: 'shared-mcp',
    config: { endpoint: `${peerUrl}/mcp`, token: 'peer-mcp-secret' } });
  assert.equal(localMcp.status, 200, JSON.stringify(localMcp.data));
  await peerRequest('PUT', `/api/connections/${localMcp.data.connection.id}/shares`, { peerIds: [peerId] });
  await waitFor(async () => (await request('GET', '/api/connections')).data.some((c: any) => c.name === 'shared-mcp'));
  const remoteMcp = { data: { connection: (await request('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-mcp') } };
  const remoteMcpId = remoteMcp.data.connection.id;
  assert.equal(remoteMcp.data.connection.kind, 'mcp');
  assert.equal(remoteMcp.data.connection.config.token, undefined);
  const remoteTools = await request('POST', `/api/connections/${remoteMcpId}/mcp/tools/list`, {});
  assert.equal(remoteTools.status, 200, JSON.stringify(remoteTools.data));
  assert.equal(remoteTools.data.tools[0].name, 'echo');
  const remoteRich = await mcp('call_mcp_tool', { connection: remoteMcpId, name: 'echo', arguments: { remote: true } });
  assert.deepEqual(remoteRich.result.structuredContent, { remote: true });
  const nativeResources = await fetch(`${centralUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }) }).then(r => r.json());
  assert.equal(nativeResources.result.resources[0].uri, `switchboard-mcp:${remoteMcpId}:file:///peer-notes`);
  const savedRemote = await request('POST', '/api/calls', { kind: 'mcp', name: 'peer-read', connectionId: remoteMcpId, mcpRequest: { operation: 'resources/read', uri: 'file:///peer-notes' } });
  assert.equal(savedRemote.status, 201);
  const savedResult = await request('POST', `/api/calls/${savedRemote.data.id}/run`, {});
  assert.equal(savedResult.data.contents[0].text, 'Peer note');
  assert.equal(fs.readFileSync(path.join(centralDir, 'switchboard.db')).includes(Buffer.from('peer-mcp-secret')), false);
  const pendingMcp = request('POST', `/api/connections/${remoteMcpId}/mcp/tools/call`, { name: 'wait' });
  await waitFor(() => waitingMcp);
  assert.equal((await peerRequest('PUT', `/api/connections/${localMcp.data.connection.id}/shares`, { peerIds: [] })).status, 200);
  assert.equal((await pendingMcp).status, 499, 'share revocation cancels an in-flight peer MCP request');

  const centralDb = fs.readFileSync(path.join(centralDir, 'switchboard.db'));
  assert.equal(centralDb.includes(Buffer.from('peer-only-secret')), false, 'central database contains no local credential plaintext');
  assert.equal((await request('GET', `/api/connections/${connected.data.connection.id}/token`)).status, 400, 'raw tokens stay on the peer');
  assert.equal((await request('DELETE', `/api/connections/${connected.data.connection.id}`)).status, 403);

  const shellService = (await peerRequest('GET', '/api/services')).data.find((s: any) => s.id === 'shell-command');
  assert.equal(shellService.methods[0].fields[0].type, 'text');
  const localShell = await peerRequest('POST', '/api/connections', { service: 'shell-command', method: 'command', name: 'shared-command', config: { command: 'printf "peer command output\\n"' } });
  assert.equal(localShell.status, 200, JSON.stringify(localShell.data));
  await peerRequest('PUT', `/api/connections/${localShell.data.connection.id}/shares`, { peerIds: [peerId] });
  await waitFor(async () => (await request('GET', '/api/connections')).data.some((c: any) => c.name === 'shared-command'));
  const shell = { data: { connection: (await request('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-command') } };
  assert.equal(shell.data.connection.config.command, undefined);
  const shellCall = await request('POST', '/api/call', { connection: shell.data.connection.id, method: 'GET', url: '/' });
  assert.equal(shellCall.status, 200, JSON.stringify(shellCall.data));
  assert.equal(shellCall.data.body, 'peer command output\n');
  assert.equal((await peerRequest('DELETE', `/api/connections/${localShell.data.connection.id}`)).status, 200);

  // The receiving machine shares back over the same socket; both ends call simultaneously.
  const incomingPeerId = enrolled.data.peer.id;
  const reverseLocal = await request('POST', '/api/connections', { service: 'http', method: 'token', name: 'from-server', config: { baseUrl: peerUrl, token: 'server-only-secret' } });
  assert.equal(reverseLocal.status, 200);
  assert.equal((await request('PUT', `/api/connections/${reverseLocal.data.connection.id}/shares/${incomingPeerId}`, { shared: true })).status, 200);
  await waitFor(async () => (await peerRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'from-server'));
  const reverseHandle = (await peerRequest('GET', '/api/connections')).data.find((c: any) => c.name === 'from-server');
  assert.equal(reverseHandle.readOnly, true); assert.deepEqual(reverseHandle.config, {});
  const both = await Promise.all([
    request('POST', '/api/call', { connection: connected.data.connection.id, url: '/local' }),
    peerRequest('POST', '/api/call', { connection: reverseHandle.id, url: '/reverse' }),
  ]);
  assert.deepEqual(both.map(r => r.status), [200, 200]);
  assert.equal(JSON.parse(both[0].data.body).auth, 'Bearer peer-only-secret');
  assert.equal(JSON.parse(both[1].data.body).auth, 'Bearer server-only-secret');
  assert.equal((await request('GET', '/api/admin/peers')).data.length, 1);
  assert.equal((await peerRequest('GET', '/api/admin/peers')).data.length, 1);
  for (const [method, suffix] of [['PATCH', ''], ['POST', '/reconnect'], ['DELETE', '']] as const) assert.equal((await peerRequest(method, `/api/connections/${reverseHandle.id}${suffix}`, {})).status, 403);
  assert.equal((await peerRequest('PUT', `/api/connections/${reverseHandle.id}/shares/${peerId}`, { shared: true })).status, 400, 'cannot share back to origin');
  const matrix = (await request('GET', '/api/connection-shares')).data;
  assert.ok(matrix.shares.some((g: any) => g.connection_id === reverseLocal.data.connection.id && g.peer_id === incomingPeerId));
  // Receiving-side permissions are local, including on the outgoing end.
  const localOwner = (await peerRequest('GET', '/api/me')).data;
  const addedUser = (await peerRequest('POST', '/api/admin/users', { username: 'local-reader' })).data;
  const ownerCookie = peerCookie;
  assert.equal((await peerRequest('POST', '/api/auth/invite', { token: addedUser.invite.url.split('#')[1], password: 'reader password' })).status, 200);
  const readerCookie = peerCookie;
  assert.ok(!(await peerRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'from-server'));
  peerCookie = ownerCookie;
  assert.equal((await peerRequest('PATCH', `/api/admin/peers/${peerId}`, { userIds: [localOwner.id, addedUser.user.id] })).status, 200);
  peerCookie = readerCookie;
  const readerHandle = (await peerRequest('GET', '/api/connections')).data.find((c: any) => c.name === 'from-server');
  assert.ok(readerHandle);
  assert.equal((await peerRequest('POST', '/api/call', { connection: readerHandle.id, url: '/' })).status, 200);
  assert.equal((await peerRequest('PUT', `/api/connections/${local.data.connection.id}/shares/${peerId}`, { shared: true })).status, 404, 'another local user cannot change owner grants');
  peerCookie = ownerCookie;
  await peerRequest('PATCH', `/api/admin/peers/${peerId}`, { userIds: [localOwner.id] });
  peerCookie = readerCookie;
  assert.equal((await peerRequest('POST', '/api/call', { connection: readerHandle.id, url: '/' })).status, 403);
  peerCookie = ownerCookie;

  const reverseMcp = await request('POST', '/api/connections', { service: 'mcp', method: 'token', name: 'from-server-mcp', config: { endpoint: `${peerUrl}/mcp`, token: 'peer-mcp-secret' } });
  await request('PUT', `/api/connections/${reverseMcp.data.connection.id}/shares/${incomingPeerId}`, { shared: true });
  await peerRequest('PUT', `/api/connections/${localMcp.data.connection.id}/shares/${peerId}`, { shared: true });
  await waitFor(async () => (await peerRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'from-server-mcp'));
  const reverseMcpHandle = (await peerRequest('GET', '/api/connections')).data.find((c: any) => c.name === 'from-server-mcp');
  const bothMcp = await Promise.all([
    request('POST', `/api/connections/${remoteMcpId}/mcp/tools/call`, { name: 'echo', arguments: { direction: 'outgoing' } }),
    peerRequest('POST', `/api/connections/${reverseMcpHandle.id}/mcp/tools/call`, { name: 'echo', arguments: { direction: 'incoming' } }),
  ]);
  assert.deepEqual(bothMcp.map(r => r.status), [200, 200]);
  assert.deepEqual(bothMcp.map(r => r.data.structuredContent), [{ direction: 'outgoing' }, { direction: 'incoming' }]);
  assert.equal((await request('PUT', `/api/connections/${reverseLocal.data.connection.id}/shares/${incomingPeerId}`, { shared: false })).status, 200);
  await waitFor(async () => (await peerRequest('GET', '/api/connections')).data.find((c: any) => c.id === reverseHandle.id)?.status === 'unavailable');
  assert.equal((await peerRequest('POST', '/api/call', { connection: reverseHandle.id })).status, 403);

  // A second peer receives a different selection, independently of the first.
  const secondPort = centralPort + 6000;
  const second = launch(secondPort, path.join(scratch, 'second-peer'));
  await waitFor(() => second.output().includes('Switchboard listening'));
  let secondCookie = '';
  const secondRequest = async (method: string, pathname: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${secondPort}${pathname}`, { method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(secondCookie ? { cookie: secondCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.headers.get('set-cookie')) secondCookie = r.headers.get('set-cookie')!.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  const secondInvite = second.output().match(/\/invite#(\S+)/)?.[1];
  assert.equal((await secondRequest('POST', '/api/auth/invite', { token: secondInvite, password: 'second password' })).status, 200);
  const secondMe = (await secondRequest('GET', '/api/me')).data;
  const secondDevice = (await secondRequest('POST', '/api/admin/peers', { name: 'Direct peer', ownerUserId: secondMe.id })).data;
  const secondLink = await peerRequest('POST', '/api/admin/peers', { direction: 'outgoing', name: 'Second', url: `http://127.0.0.1:${secondPort}`, token: secondDevice.token });
  assert.equal(secondLink.status, 201, JSON.stringify(secondLink.data));
  const secondLocal = await peerRequest('POST', '/api/connections', { service: 'http', method: 'token', name: 'second-only', config: { baseUrl: peerUrl, token: 'second-only-secret' } });
  await peerRequest('PUT', `/api/connections/${secondLocal.data.connection.id}/shares`, { peerIds: [secondLink.data.peer.id] });
  await waitFor(async () => (await secondRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'second-only'));
  assert.ok(!(await secondRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'shared-api'));
  assert.ok(!(await request('GET', '/api/connections')).data.some((c: any) => c.name === 'second-only'));
  assert.equal((await request('POST', '/api/call', { connection: connected.data.connection.id, method: 'GET', url: '/local' })).status, 200);

  // Explicit onward sharing crosses two links; reverse sharing cannot form a cycle.
  const chainDevice = (await secondRequest('POST', '/api/admin/peers', { name: 'Intermediate', ownerUserId: secondMe.id })).data;
  const chainLink = await request('POST', '/api/admin/peers', { direction: 'outgoing', name: 'Chain', url: `http://127.0.0.1:${secondPort}`, token: chainDevice.token });
  assert.equal(chainLink.status, 201, JSON.stringify(chainLink.data));
  await request('PUT', `/api/connections/${connected.data.connection.id}/shares`, { peerIds: [chainLink.data.peer.id] });
  await waitFor(async () => (await secondRequest('GET', '/api/connections')).data.some((c: any) => c.name === 'shared-api'));
  const chainHandle = (await secondRequest('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-api');
  const chainCall = await secondRequest('POST', '/api/call', { connection: chainHandle.id, method: 'GET', url: '/local' });
  assert.equal(chainCall.status, 200, JSON.stringify(chainCall.data));
  assert.equal(JSON.parse(chainCall.data.body).auth, 'Bearer peer-only-secret');
  const localMe = (await peerRequest('GET', '/api/me')).data;
  const reverseDevice = (await peerRequest('POST', '/api/admin/peers', { name: 'Reverse link', ownerUserId: localMe.id })).data;
  const reverseLink = await secondRequest('POST', '/api/admin/peers', { direction: 'outgoing', name: 'Reverse', url: `http://127.0.0.1:${peerPort}`, token: reverseDevice.token });
  await secondRequest('PUT', `/api/connections/${chainHandle.id}/shares`, { peerIds: [reverseLink.data.peer.id] });
  await waitFor(async () => (await peerRequest('GET', '/api/admin/peers')).data.some((s: any) => s.name === 'Reverse link' && s.online));
  assert.deepEqual((await peerRequest('GET', '/api/admin/peers')).data.find((s: any) => s.name === 'Reverse link').connections, []);
  await peerRequest('PUT', `/api/connections/${local.data.connection.id}/shares`, { peerIds: [] });
  await waitFor(async () => (await secondRequest('GET', '/api/connections')).data.find((c: any) => c.id === chainHandle.id)?.status === 'unavailable');
  assert.equal((await secondRequest('POST', '/api/call', { connection: chainHandle.id, method: 'GET', url: '/local' })).status, 403);
  assert.equal((await secondRequest('POST', '/api/call', { connection: 'second-only', method: 'GET', url: '/local' })).status, 200);

});
