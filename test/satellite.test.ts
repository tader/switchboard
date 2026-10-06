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

test('a real satellite keeps credentials local and executes a per-user connection', async () => {
  upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'application/json' });
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
  await waitFor(async () => (await request('GET', '/api/admin/satellites')).data[0]?.online === true);
  await waitFor(async () => (await request('GET', '/api/services')).data.some((s: any) => s.id === `sat/${enrolled.data.satellite.id}/http`));

  const connected = await request('POST', '/api/connections', {
    service: `sat/${enrolled.data.satellite.id}/http`, method: 'token',
    config: { baseUrl: upstreamUrl, token: 'satellite-only-secret', label: 'Private local API' },
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

  const centralDb = fs.readFileSync(path.join(centralDir, 'switchboard.db'));
  assert.equal(centralDb.includes(Buffer.from('satellite-only-secret')), false, 'central database contains no local credential plaintext');
  assert.equal((await request('GET', `/api/connections/${connected.data.connection.id}/token`)).status, 400, 'raw tokens stay on the satellite');
  assert.equal((await request('DELETE', `/api/connections/${connected.data.connection.id}`)).status, 200);
});
