import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import * as tar from 'tar';
import { installFixturePlugins } from './plugin-fixtures.ts';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-peer-github-'));
const children: ChildProcess[] = [];
let upstream: http.Server;
const secret = 'github-token-stays-on-owner';
const seen: { path: string; host: string; instance: string; auth?: string }[] = [];
const commits = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
const archives = new Map<string, Buffer>();
let release = 0;

const waitFor = async (fn: () => boolean | Promise<boolean>) => {
  for (let n = 0; n < 150; n++) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for peer state');
};
after(() => {
  for (const child of children) child.kill();
  upstream?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function launch(role: string, port: number, providerUrl: string, extra: Record<string, string> = {}) {
  const dir = path.join(scratch, role);
  if (role === 'owner') installFixturePlugins(dir, ['github']);
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', path.join(scratch, 'fake-github.mjs'), 'server/main.ts'], {
    cwd: root,
    env: { ...process.env, SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SWITCHBOARD_DATA_DIR: dir, SWITCHBOARD_WATCH_PLUGINS: 'false', SWITCHBOARD_GITHUB_TOKEN: '',
      SWITCHBOARD_TEST_GITHUB_ORIGIN: providerUrl, SWITCHBOARD_TEST_INSTANCE: role, ...extra },
  });
  children.push(child);
  child.stdout!.on('data', chunk => output += chunk);
  child.stderr!.on('data', chunk => output += chunk);
  await waitFor(() => output.includes('Switchboard listening'));
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method,
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    return { status: response.status, data: await response.json() as any };
  };
  const token = output.match(/\/invite#(\S+)/)?.[1];
  assert.ok(token, output);
  assert.equal((await call('POST', '/api/auth/invite', { token, password: 'temporary peer test password' })).status, 200);
  return { call, dir };
}

test('plugin releases, installation and updates use a shared GitHub connection without copying its token', async () => {
  for (let n = 0; n < commits.length; n++) {
    const dir = path.join(scratch, commits[n], 'archive-root');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'peer-github-app', name: 'Peer GitHub app', version: `1.${n}.0` }));
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export default () => ({});');
    // Private archive redirects must be downloaded without credentials, outside the 1 MB peer response limit.
    fs.writeFileSync(path.join(dir, 'data.bin'), randomBytes(1100 * 1024));
    const file = path.join(scratch, commits[n] + '.tgz');
    await tar.c({ gzip: true, file, cwd: path.dirname(dir) }, ['archive-root']);
    archives.set(commits[n], fs.readFileSync(file));
  }
  upstream = http.createServer((req, res) => {
    const pathname = req.url!;
    const host = String(req.headers['x-test-upstream']);
    seen.push({ path: pathname, host, instance: String(req.headers['x-test-instance']), auth: req.headers.authorization });
    if (host === 'codeload.github.com') {
      assert.equal(req.headers.authorization, undefined);
      res.end(archives.get(pathname.split('/').at(-1)!)); return;
    }
    if (pathname.includes('/contents/') && req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(429); res.end('{}'); return; }
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (pathname.includes('/contents/')) { res.end(JSON.stringify({ schemaVersion: 1, plugins: [{ id: 'peer-github-app', name: 'Peer app', description: '', repo: 'owner/private' }] })); return; }
    if (pathname === '/user') { res.end(JSON.stringify({ id: 1, login: 'owner' })); return; }
    if (pathname.includes('/releases')) {
      const items = Array.from({ length: release + 1 }, (_, n) => ({ tag_name: `v1.${release - n}.0`, published_at: '2026-01-01T00:00:00Z' }));
      res.end(JSON.stringify(pathname.endsWith('/latest') ? items[0] : items)); return;
    }
    if (pathname.includes('/commits/')) {
      const ref = decodeURIComponent(pathname.split('/commits/')[1]);
      const sha = commits.includes(ref) ? ref : commits[Number(ref.split('.')[1])];
      res.end(sha); return;
    }
    if (pathname.includes('/tarball/')) {
      res.writeHead(302, { location: `https://codeload.github.com/owner/private/${pathname.split('/').at(-1)}` }); res.end(); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  fs.writeFileSync(path.join(scratch, 'fake-github.mjs'), `
    const original = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      const url = new URL(input);
      if (!['api.github.com', 'codeload.github.com'].includes(url.hostname)) return original(input, init);
      const headers = new Headers(init.headers);
      headers.set('x-test-upstream', url.hostname);
      headers.set('x-test-instance', process.env.SWITCHBOARD_TEST_INSTANCE);
      return original(process.env.SWITCHBOARD_TEST_GITHUB_ORIGIN + url.pathname + url.search, { ...init, headers });
    };
  `);
  // Keep both instances outside the existing peer/WebSocket test port ranges.
  const port = 40000 + Math.floor(Math.random() * 900);
  const consumer = await launch('consumer', port, providerUrl);
  const enrollment = await consumer.call('POST', '/api/admin/peers', { name: 'GitHub owner' });
  assert.equal(enrollment.status, 201, JSON.stringify(enrollment.data));
  const owner = await launch('owner', port + 4000, providerUrl, {
    SWITCHBOARD_PEER_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_PEER_TOKEN: enrollment.data.token,
  });
  await waitFor(async () => (await owner.call('GET', '/api/admin/peers')).data[0]?.online);
  const ownerPeer = (await owner.call('GET', '/api/admin/peers')).data[0].id;
  const connected = await owner.call('POST', '/api/connections', { service: 'github', method: 'token', name: 'shared-github', config: { token: secret } });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  const ownerConnection = connected.data.connection.id;
  assert.equal((await consumer.call('GET', '/api/connections')).data.length, 0, 'unshared connections are invisible');
  await owner.call('PUT', `/api/connections/${ownerConnection}/shares`, { peerIds: [ownerPeer] });
  let shared: any;
  await waitFor(async () => {
    shared = (await consumer.call('GET', '/api/connections')).data.find((c: any) => c.name === 'shared-github');
    return shared?.status === 'ok';
  });
  assert.match(shared.serviceId, /^peer\/[^/]+\/github$/);
  assert.deepEqual(shared.config, {});
  const catalog = await consumer.call('GET', '/api/admin/plugins/community');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
  assert.equal(catalog.data.plugins[0].id, 'peer-github-app');
  assert(seen.some(r => r.path.includes('/contents/') && r.instance === 'consumer' && !r.auth));
  assert(seen.some(r => r.path.includes('/contents/') && r.instance === 'owner' && r.auth === `Bearer ${secret}`));

  const list = await consumer.call('POST', '/api/admin/plugins/releases', { repo: 'owner/private', githubConnectionId: shared.id });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data[0].tag, 'v1.0.0');
  const plan = await consumer.call('POST', '/api/admin/plugins/install/plan', { repo: 'owner/private' });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(plan.data.changes[0].source.githubConnectionId, shared.id, 'automatic selection remembers the shared handle');
  assert.equal((await consumer.call('POST', '/api/admin/plugins/apply', { planId: plan.data.planId })).status, 200);
  assert.equal(fs.existsSync(path.join(consumer.dir, 'plugins/github')), false, 'no local GitHub plugin is required');
  release = 1;
  const updates = await consumer.call('POST', '/api/admin/plugins/check-updates', {});
  assert.equal(updates.status, 200);
  assert.equal(updates.data.find((p: any) => p.id === 'peer-github-app').updateAvailable, true);
  const updated = await consumer.call('POST', '/api/admin/plugins/peer-github-app/update', {});
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.plugin.version, '1.1.0');
  assert.equal(updated.data.plugin.source.githubConnectionId, shared.id);
  assert(seen.some(r => r.instance === 'consumer' && r.host === 'api.github.com' && !r.auth), 'automatic public access was tried');
  assert(seen.filter(r => r.auth).every(r => r.instance === 'owner' && r.auth === `Bearer ${secret}`));
  assert(seen.filter(r => r.host === 'codeload.github.com').every(r => r.instance === 'consumer' && !r.auth));
  assert.equal((await consumer.call('GET', `/api/connections/${shared.id}/token`)).status, 400);
  assert(!JSON.stringify((await consumer.call('GET', '/api/audit')).data).includes(secret));
  const ownerAudit = (await owner.call('GET', '/api/audit?source=plugin')).data;
  assert(ownerAudit.total > 0, 'plugin activity is classified on the owning peer too');
  assert(!JSON.stringify(ownerAudit).includes(secret));
  const other = await owner.call('POST', '/api/connections', { service: 'http', method: 'token', name: 'not-github', config: { baseUrl: providerUrl, token: 'unrelated-service-secret' } });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  await owner.call('PUT', `/api/connections/${other.data.connection.id}/shares`, { peerIds: [ownerPeer] });
  let wrong: any;
  await waitFor(async () => {
    wrong = (await consumer.call('GET', '/api/connections')).data.find((c: any) => c.name === 'not-github');
    return !!wrong;
  });
  assert.equal((await consumer.call('POST', '/api/admin/plugins/releases', { repo: 'owner/private', githubConnectionId: wrong.id })).status, 400);

  for (const file of ['switchboard.db', 'switchboard.db-wal']) if (fs.existsSync(path.join(consumer.dir, file))) {
    assert(!fs.readFileSync(path.join(consumer.dir, file)).includes(Buffer.from(secret)), 'consumer stores no upstream token');
  }
  release = 2;
  const preview = await consumer.call('POST', '/api/admin/plugins/update/plan', { updates: [{ id: 'peer-github-app', githubConnectionId: shared.id }] });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  await owner.call('PUT', `/api/connections/${ownerConnection}/shares`, { peerIds: [] });
  await waitFor(async () => (await consumer.call('GET', '/api/connections')).data.find((c: any) => c.id === shared.id)?.status === 'unavailable');
  const applied = await consumer.call('POST', '/api/admin/plugins/apply', { planId: preview.data.planId });
  assert.equal(applied.status, 503, JSON.stringify(applied.data));
  assert.equal((await consumer.call('GET', '/api/admin/plugins/peer-github-app')).data.version, '1.1.0');
  assert.equal((await consumer.call('POST', '/api/admin/plugins/releases', { repo: 'owner/private', githubConnectionId: shared.id })).status, 503);
  await owner.call('PUT', `/api/connections/${ownerConnection}/shares`, { peerIds: [ownerPeer] });
  await waitFor(async () => (await consumer.call('GET', '/api/connections')).data.find((c: any) => c.id === shared.id)?.status === 'ok');
  await consumer.call('PATCH', `/api/admin/peers/${enrollment.data.peer.id}`, { disabled: true });
  const offline = await consumer.call('POST', '/api/admin/plugins/releases', { repo: 'owner/private', githubConnectionId: shared.id });
  assert.equal(offline.status, 503, JSON.stringify(offline.data));
});
