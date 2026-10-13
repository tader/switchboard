import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-ws-peer-'));
const processes: ChildProcess[] = [];
const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
let tokens: string[] = [];
let stopped = 0;
upstream.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'auth_required' }));
  let authenticated = false;
  socket.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (!authenticated) { tokens.push(msg.access_token); authenticated = msg.access_token === 'upstream-secret'; socket.send(JSON.stringify({ type: authenticated ? 'auth_ok' : 'auth_invalid' })); return; }
    if (msg.type === 'stop') stopped++;
    socket.send(JSON.stringify({ type: 'result', id: msg.id, result: { value: msg.value ?? 'ok' } }));
    if (msg.type === 'watch') socket.send(JSON.stringify({ type: 'event', id: msg.id, event: { value: 'peer-event' } }));
  });
});
after(async () => { for (const socket of upstream.clients) socket.terminate(); upstream.close(); for (const process of processes) process.kill(); await new Promise(resolve => setTimeout(resolve, 100)); fs.rmSync(scratch, { recursive: true, force: true }); });
async function waitFor(fn: () => any | Promise<any>) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for WebSocket peer');
}
async function launch(name: string, port: number) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/websocket-plugin'), path.join(dir, 'plugins/websocket-test'), { recursive: true });
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env,
    SWITCHBOARD_PORT: String(port), SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_DATA_DIR: dir, SWITCHBOARD_WATCH_PLUGINS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child); child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
  await waitFor(() => output.includes('Switchboard listening'));
  let cookie = '';
  const url = `http://127.0.0.1:${port}`;
  const request = async (method: string, pathname: string, body?: unknown, secret?: string) => {
    const response = await fetch(url + pathname, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(secret ? { authorization: `Bearer ${secret}` } : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, data: await response.json() as any };
  };
  const invitation = output.match(/\/invite#(\S+)/)?.[1]; assert.ok(invitation, output);
  assert.equal((await request('POST', '/api/auth/invite', { token: invitation, password: 'test-password' })).status, 200);
  const user = (await request('GET', '/api/me')).data;
  return { request, user, url, dir, child };
}
test('WebSocket commands and leases forward across multiple peers; revocation and link loss release resources', async () => {
  await waitFor(() => upstream.address());
  const port = 46000 + Math.floor(Math.random() * 900);
  const origin = await launch('origin', port);
  const middle = await launch('middle', port + 1000);
  const gateway = await launch('gateway', port + 2000);
  async function pair(receiver: typeof origin, sender: typeof origin) {
    const accepted = await receiver.request('POST', '/api/admin/peers', { name: `Peer ${sender.url}`, ownerUserId: receiver.user.id });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    const outgoing = await sender.request('POST', '/api/admin/peers', { direction: 'outgoing', name: `Remote ${receiver.url}`, url: receiver.url, token: accepted.data.token, ownerUserId: sender.user.id });
    assert.equal(outgoing.status, 201, JSON.stringify(outgoing.data));
    await waitFor(async () => (await receiver.request('GET', '/api/admin/peers')).data.some((p: any) => p.id === accepted.data.peer.id && p.online));
    return { incoming: accepted.data.peer.id, outgoing: outgoing.data.peer.id };
  }
  const first = await pair(middle, origin);
  const second = await pair(gateway, middle);
  const conn = await origin.request('POST', '/api/connections', { service: 'websocket-test', method: 'message', name: 'shared-ws', config: { endpoint: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token: 'upstream-secret' } });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  await origin.request('PUT', `/api/connections/${conn.data.connection.id}/shares`, { peerIds: [first.outgoing] });
  let mid: any;
  await waitFor(async () => { mid = (await middle.request('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-ws'); return mid?.hasWebSocket; });
  const middleCall = await middle.request('POST', `/api/connections/${mid.id}/websocket/call`, { operationId: 'echo/value', arguments: { value: 'one-hop' } });
  assert.equal(middleCall.status, 200, JSON.stringify(middleCall.data)); assert.equal(middleCall.data.result.value, 'one-hop');
  await middle.request('PUT', `/api/connections/${mid.id}/shares`, { peerIds: [second.outgoing] });
  let imported: any;
  await waitFor(async () => { imported = (await gateway.request('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-ws'); return imported?.hasWebSocket; });
  const root = `/api/connections/${imported.id}/websocket`;
  const call = await gateway.request('POST', `${root}/call`, { operationId: 'echo/value', arguments: { value: 'two-hop' } });
  assert.equal(call.status, 200, JSON.stringify(call.data)); assert.equal(call.data.result.value, 'two-hop');
  const descriptor = await gateway.request('GET', `${root}/operations/${encodeURIComponent('echo/value')}`); assert.equal(descriptor.data.operation.mode, 'command');
  const token = (await gateway.request('POST', '/api/tokens', { name: 'WS MCP', connectionIds: [imported.id] })).data.secret;
  const mcp = await gateway.request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_websocket_operation', arguments: { connection: imported.id, operationId: 'echo/value', arguments: { value: 'mcp-hop' } } } }, token);
  assert.equal(mcp.data.result.structuredContent.result.value, 'mcp-hop');
  const start = await gateway.request('POST', `${root}/subscriptions`, { operationId: 'watch' }); assert.equal(start.status, 200, JSON.stringify(start.data));
  const page = await gateway.request('POST', `${root}/subscriptions/${start.data.id}/read`, { waitMs: 1000 });
  assert.equal(page.status, 200, JSON.stringify(page.data)); assert.equal(page.data.events[0].value.value, 'peer-event');
  const prior = stopped;
  assert.equal((await gateway.request('DELETE', `${root}/subscriptions/${start.data.id}`)).data.status, 'stopped');
  await waitFor(() => stopped > prior);
  // Token revocation stops a remote handle without requiring the revoked token to authorize cleanup.
  const revocable = (await gateway.request('POST', '/api/tokens', { name: 'revocable WS', connectionIds: [imported.id] })).data;
  const remoteLease = await gateway.request('POST', `${root}/subscriptions`, { operationId: 'watch' }, revocable.secret);
  assert.equal(remoteLease.status, 200, JSON.stringify(remoteLease.data));
  const beforeRevocation = stopped;
  const tokenId = revocable.token?.id ?? revocable.id;
  assert.ok(tokenId);
  assert.equal((await gateway.request('DELETE', `/api/tokens/${tokenId}`)).status, 200);
  await waitFor(() => stopped > beforeRevocation);
  assert.ok(tokens.every(token => token === 'upstream-secret'));
  for (const instance of [middle, gateway]) assert.equal(fs.readFileSync(path.join(instance.dir, 'switchboard.db')).includes(Buffer.from('upstream-secret')), false);
  const revoked = await gateway.request('POST', `${root}/subscriptions`, { operationId: 'watch' });
  await origin.request('PUT', `/api/connections/${conn.data.connection.id}/shares`, { peerIds: [] });
  await waitFor(async () => { const result = await gateway.request('POST', `${root}/subscriptions/${revoked.data.id}/read`, {}); return result.status === 403 || result.status === 404 || result.data.status === 'interrupted'; });
  assert.ok((await gateway.request('POST', `${root}/call`, { operationId: 'echo/value', arguments: { value: 'denied' } })).status >= 400);
  // Restore sharing, then prove link failure stops a newly acknowledged subscription.
  await origin.request('PUT', `/api/connections/${conn.data.connection.id}/shares`, { peerIds: [first.outgoing] });
  await waitFor(async () => (await gateway.request('GET', `${root}/operations`)).status === 200);
  const interrupted = await gateway.request('POST', `${root}/subscriptions`, { operationId: 'watch' }); assert.equal(interrupted.status, 200);
  await gateway.request('POST', `${root}/subscriptions/${interrupted.data.id}/read`, { waitMs: 1000 });
  middle.child.kill();
  await waitFor(async () => { const result = await gateway.request('POST', `${root}/subscriptions/${interrupted.data.id}/read`, {}); return result.data.status === 'interrupted' || result.status >= 400; });
});
