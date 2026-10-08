import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-satellite-'));
const processes: ChildProcess[] = [];
let upstream: http.Server | undefined;

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 12_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timeout');
};

function launch(port: number, dataDir: string, extra: Record<string, string> = {}) {
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
  upstream?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

let waitingMcp = false;

test('a real satellite keeps credentials local and executes a per-user connection', async () => {
  upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/mcp') {
      const msg = JSON.parse(body);
      assert.equal(request.headers.authorization, 'Bearer satellite-mcp-secret');
      if (msg.method === 'tools/call' && msg.params.name === 'wait') { waitingMcp = true; return; }
      const modern = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
      const result = msg.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Satellite MCP', version: '1' } } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }], ttlMs: 0, cacheScope: 'private' }
        : msg.method === 'resources/list' ? { resources: [{ name: 'notes', uri: 'file:///satellite-notes' }], ttlMs: 0, cacheScope: 'private' }
        : msg.method === 'resources/read' ? { contents: [{ uri: msg.params.uri, text: 'Satellite note' }], ttlMs: 0, cacheScope: 'private' }
        : { content: [{ type: 'text', text: 'Satellite MCP result' }], structuredContent: msg.params.arguments };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ...(modern ? { resultType: 'complete' } : {}), ...result } }));
      return;
    }
    if (request.url === '/spec.json') {
      response.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Satellite test', version: '1' }, paths: { '/local': { post: { operationId: 'localCall', summary: 'Call the local API', responses: { 200: { description: 'OK' } } } } } }));
      return;
    }
    response.end(JSON.stringify({ path: request.url, auth: request.headers.authorization, body }));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const centralPort = 31000 + Math.floor(Math.random() * 2000);
  const satellitePort = centralPort + 3000;
  const centralUrl = `http://127.0.0.1:${centralPort}`;
  const centralDir = path.join(scratch, 'central');
  const satelliteDir = path.join(scratch, 'satellite');
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
  const enrolled = await request('POST', '/api/admin/satellites', { name: 'Test laptop', ownerUserId: me.id });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));

  const satellite = launch(satellitePort, satelliteDir, {
    SWITCHBOARD_SATELLITE_CENTRAL_URL: centralUrl,
    SWITCHBOARD_SATELLITE_TOKEN: enrolled.data.token,
  });
  await waitFor(() => satellite.output().includes('Switchboard listening'));
  let satelliteCookie = '';
  const satelliteRequest = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${satellitePort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(satelliteCookie ? { cookie: satelliteCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) satelliteCookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const satelliteInvitation = satellite.output().match(/\/invite#(\S+)/)?.[1];
  assert.ok(satelliteInvitation, satellite.output());
  assert.equal((await satelliteRequest('POST', '/api/auth/invite', { token: satelliteInvitation, password: 'satellite password' })).status, 200);
  assert.equal((await satelliteRequest('PUT', '/api/admin/plugins/shell-command/settings', { enabled: true })).status, 200);
  await waitFor(async () => (await request('GET', '/api/admin/satellites')).data[0]?.online === true);
  const upstreamState = await satelliteRequest('GET', '/api/admin/satellite-upstream');
  assert.equal(upstreamState.data.configured, true);
  assert.equal(upstreamState.data.state, 'online');
  assert.equal(upstreamState.data.centralUrl, centralUrl);
  assert.equal((await request('GET', '/api/admin/satellite-upstream')).data.configured, false, 'a central instance has no upstream');
  await waitFor(async () => (await request('GET', '/api/services')).data.some((s: any) => s.id === `sat/${enrolled.data.satellite.id}/http`));
  const remoteHttp = (await request('GET', '/api/services')).data.find((s: any) => s.id === `sat/${enrolled.data.satellite.id}/http`);
  assert.deepEqual(remoteHttp.satellite, { id: enrolled.data.satellite.id, name: 'Test laptop', online: true });

  const connected = await request('POST', '/api/connections', {
    service: `sat/${enrolled.data.satellite.id}/http`, method: 'token',
    config: { baseUrl: upstreamUrl, token: 'satellite-only-secret', label: 'Private local API', openapi: `${upstreamUrl}/spec.json` },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  assert.equal(connected.data.connection.satellite.name, 'Test laptop');
  assert.equal(connected.data.connection.config.token, undefined, 'secret config is not returned to central');

  const called = await request('POST', '/api/call', { connection: connected.data.connection.id, method: 'POST', url: '/local', body: 'hello' });
  assert.equal(called.status, 200, JSON.stringify(called.data));
  const result = JSON.parse(called.data.body);
  assert.equal(result.path, '/local');
  assert.equal(result.auth, 'Bearer satellite-only-secret');
  assert.equal(result.body, 'hello');

  const satelliteAudit = await satelliteRequest('GET', '/api/audit');
  assert.equal(satelliteAudit.status, 200);
  assert.equal(satelliteAudit.data.total, 1, JSON.stringify(satelliteAudit.data));
  assert.equal(satelliteAudit.data.items[0].connection.name, connected.data.connection.name);
  assert.equal(satelliteAudit.data.items[0].client.name, 'Upstream: Web console');
  assert.equal(satelliteAudit.data.items[0].source, 'console');
  assert.equal(satelliteAudit.data.items[0].status, 200);
  assert.ok(satelliteAudit.data.items[0].responseSize > 0);
  const satelliteFacets = await satelliteRequest('GET', '/api/audit/facets');
  assert.equal(satelliteFacets.data.connections[0].count, 1);
  assert.equal(satelliteFacets.data.clients[0].name, 'Upstream: Web console');

  const mcpToken = (await request('POST', '/api/tokens', { name: 'Satellite MCP test' })).data.secret;
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
  assert.deepEqual(mcpRemote.location, { type: 'satellite', name: 'Test laptop', online: true });
  const operations = await mcp('search_operations', { connection: connected.data.connection.name, query: 'local' });
  assert.equal(operations.result.isError, undefined, JSON.stringify(operations));
  assert.deepEqual(operations.result.structuredContent.operations[0], {
    operationId: 'localCall', method: 'POST', path: '/local', summary: 'Call the local API',
    parameters: { path: [], query: [], header: [] },
  });
  const mcpCall = await mcp('call_operation', { connection: connected.data.connection.name, operationId: 'localCall' });
  assert.equal(mcpCall.result.isError, undefined, JSON.stringify(mcpCall));
  assert.match(mcpCall.result.content[0].text, /^HTTP 200/);
  const satelliteMcpAudit = await satelliteRequest('GET', '/api/audit?source=mcp');
  assert.equal(satelliteMcpAudit.data.total, 1);
  assert.equal(satelliteMcpAudit.data.items[0].client.name, 'Upstream: Satellite MCP test');

  const remoteMcp = await request('POST', '/api/connections', {
    service: `sat/${enrolled.data.satellite.id}/mcp`, method: 'token',
    config: { endpoint: `${upstreamUrl}/mcp`, token: 'satellite-mcp-secret' },
  });
  assert.equal(remoteMcp.status, 200, JSON.stringify(remoteMcp.data));
  const remoteMcpId = remoteMcp.data.connection.id;
  assert.equal(remoteMcp.data.connection.kind, 'mcp');
  assert.equal(remoteMcp.data.connection.config.token, undefined);
  const remoteTools = await request('POST', `/api/connections/${remoteMcpId}/mcp/tools/list`, {});
  assert.equal(remoteTools.status, 200, JSON.stringify(remoteTools.data));
  assert.equal(remoteTools.data.tools[0].name, 'echo');
  const remoteRich = await mcp('call_mcp_tool', { connection: remoteMcpId, name: 'echo', arguments: { remote: true } });
  assert.deepEqual(remoteRich.result.structuredContent, { remote: true });
  const nativeResources = await fetch(`${centralUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }) }).then(r => r.json());
  assert.equal(nativeResources.result.resources[0].uri, `switchboard-mcp:${remoteMcpId}:file:///satellite-notes`);
  const savedRemote = await request('POST', '/api/calls', { kind: 'mcp', name: 'satellite-read', connectionId: remoteMcpId, mcpRequest: { operation: 'resources/read', uri: 'file:///satellite-notes' } });
  assert.equal(savedRemote.status, 201);
  const savedResult = await request('POST', `/api/calls/${savedRemote.data.id}/run`, {});
  assert.equal(savedResult.data.contents[0].text, 'Satellite note');
  assert.equal(fs.readFileSync(path.join(centralDir, 'switchboard.db')).includes(Buffer.from('satellite-mcp-secret')), false);
  const pendingMcp = request('POST', `/api/connections/${remoteMcpId}/mcp/tools/call`, { name: 'wait' });
  await waitFor(() => waitingMcp);
  assert.equal((await request('DELETE', `/api/connections/${remoteMcpId}`)).status, 200);
  assert.equal((await pendingMcp).status, 499, 'connection deletion cancels an in-flight satellite MCP request');

  const centralDb = fs.readFileSync(path.join(centralDir, 'switchboard.db'));
  assert.equal(centralDb.includes(Buffer.from('satellite-only-secret')), false, 'central database contains no local credential plaintext');
  assert.equal((await request('GET', `/api/connections/${connected.data.connection.id}/token`)).status, 400, 'raw tokens stay on the satellite');
  assert.equal((await request('DELETE', `/api/connections/${connected.data.connection.id}`)).status, 200);

  await waitFor(async () => {
    const service = (await request('GET', '/api/services')).data.find((s: any) => s.id === `sat/${enrolled.data.satellite.id}/shell-command`);
    return service?.methods[0]?.unavailable === undefined;
  });
  const shellService = (await request('GET', '/api/services')).data.find((s: any) => s.id === `sat/${enrolled.data.satellite.id}/shell-command`);
  assert.equal(shellService.methods[0].fields[0].type, 'text');
  const shell = await request('POST', '/api/connections', {
    service: `sat/${enrolled.data.satellite.id}/shell-command`, method: 'command',
    config: { command: 'printf "satellite command output\\n"' },
  });
  assert.equal(shell.status, 200, JSON.stringify(shell.data));
  assert.equal(shell.data.connection.config.command, undefined);
  const shellCall = await request('POST', '/api/call', { connection: shell.data.connection.id, method: 'GET', url: '/' });
  assert.equal(shellCall.status, 200, JSON.stringify(shellCall.data));
  assert.equal(shellCall.data.body, 'satellite command output\n');
  assert.equal((await request('DELETE', `/api/connections/${shell.data.connection.id}`)).status, 200);
});
