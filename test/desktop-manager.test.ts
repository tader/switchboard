import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { inspectArchive, safeEntry, validateManifest } from '../updater/runtime.ts';
import { validateSettings, Controller, assertListenAvailable } from '../updater/engine.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-manager-unit-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
test('prepared runtime archives reject links, traversal, metadata and truncation', () => {
  for (const [name, type] of [['../escape','0'], ['/absolute','0'], ['link','2'], ['hardlink','1'], ['metadata','x']]) {
    const header = Buffer.alloc(1024); header.write(name); header.write('00000000000',124); header.write(type,156);
    assert.throws(() => inspectArchive(gzipSync(header)), /Unsafe/);
  }
  assert.throws(() => inspectArchive(gzipSync(Buffer.alloc(512,1))));
  safeEntry('node_modules/package/index.js', 'File');
  const manifest = { origin: 'tader/switchboard' as const, version: '1.0.0', revision: 'a'.repeat(40), protocol: 1 as const, platform: 'darwin' as const, arch: 'arm64' as const, archive: 'switchboard-runtime-darwin-arm64.tar.gz', sha256: 'b'.repeat(64) };
  validateManifest(manifest, manifest, 'arm64');
  assert.throws(() => validateManifest(manifest, { version: '2.0.0', revision: manifest.revision }, 'arm64'));
  assert.throws(() => validateManifest(manifest, manifest, 'x64'));
});
test('container-only private appUrl opt-in preserves host HTTP restrictions and active image persistence', () => {
  const s = { instance: 'synthetic', mode: 'compose' as const, dataDir: '/data', stateDir: root, appUrl: 'http://switchboard:8770', env: {}, compose: { project: 'synthetic', directory: root, service: 'switchboard', files: [path.join(root,'compose.yaml')], privateNetwork: true, dataVolume: 'synthetic-data', stateVolume: 'synthetic-state' } };
  validateSettings(s);
  assert.throws(() => validateSettings({ ...s, compose: { ...s.compose, privateNetwork: false } }), /HTTPS/);
  assert.throws(() => validateSettings({ ...s, appUrl: 'http://other-service:8770' }), /HTTPS/);
  const c = new Controller(s); c.override('sha256:' + 'a'.repeat(64), false);
  assert.ok(c.composeArgs().includes(path.join(root,'active-compose.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'active-compose.json'),'utf8')).services.switchboard.environment.SWITCHBOARD_START_GATED, '0');
});
test('attention records only typed terminal authentication failures and clears on recovery', async () => {
  process.env.SWITCHBOARD_DATA_DIR = path.join(root,'data'); fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR);
  const database = await import('../server/db.ts'); const { initDb, run, one } = database; initDb();
  const { authenticationFailed, authenticationRecovered } = await import('../server/attention.ts');
  run("INSERT INTO users(id,username,role,created_at) VALUES('u','synthetic','admin',0)");
  run("INSERT INTO connections(id,user_id,service_id,method_id,name,created_at,updated_at) VALUES('c','u','synthetic','direct','Synthetic',0,0)");
  for (const e of [Error('invalid credentials'), Object.assign(Error('offline'),{code:'ETIMEDOUT'}), Object.assign(Error('offline'),{code:'ECONNREFUSED'})]) authenticationFailed('c', e);
  assert.equal(one('SELECT COUNT(*) AS n FROM connection_attention')?.n,0);
  authenticationFailed('c', {code:'invalid_grant'}); assert.equal(one('SELECT COUNT(*) AS n FROM connection_attention')?.n,1);
  authenticationFailed('c', Error('offline')); assert.equal(one('SELECT COUNT(*) AS n FROM connection_attention')?.n,1);
  authenticationRecovered('c'); assert.equal(one('SELECT COUNT(*) AS n FROM connection_attention')?.n,0); database.db.close();
});

test('runtime port conflict preserves the existing listener', async () => {
  const listener = net.createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as net.AddressInfo).port;
  try { await assert.rejects(assertListenAvailable('127.0.0.1', port), /unavailable/); assert.equal(listener.listening, true); }
  finally { await new Promise<void>(r => listener.close(() => r())); }
  await assertListenAvailable('127.0.0.1', port);
});
