import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFixturePlugins } from './plugin-fixtures.ts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-extraction-'));
process.env.SWITCHBOARD_DATA_DIR = dataDir;
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
const database = await import('../server/db.ts');
const { initDb, one } = database;
const { initKey } = await import('../server/crypto.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const { createUser } = await import('../server/users.ts');
const { startConnect, loadConnection, toView } = await import('../server/connections.ts');
initKey(); initDb();
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await plugins.stop();
  database.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('core-only startup and external reinstall preserve credentials, settings, disabled state and plugin data', async () => {
  await plugins.start();
  assert.deepEqual([...plugins.plugins.keys()].sort(), ['api-key', 'mcp', 'oauth2']);
  assert.deepEqual([...plugins.services.keys()].sort(), ['http', 'mcp', 'oauth2']);
  installFixturePlugins(dataDir, ['github']);
  await plugins.reload(['github']);
  assert.equal(plugins.get('github').origin, 'installed');
  await plugins.saveSettings('github', { clientId: 'existing-client', clientSecret: 'existing-secret' });
  const user = createUser('migration-admin', 'admin');
  globalThis.fetch = (async (input: any) => {
    assert.equal(String(input), 'https://api.github.com/user');
    return Response.json({ id: 1, login: 'migration-user' });
  }) as typeof fetch;
  const result = await startConnect(user, { service: 'github', method: 'token', name: 'existing', config: { token: 'existing-pat' } });
  assert.equal(result.status, 'connected');
  if (result.status !== 'connected') throw new Error('Expected connection');
  const connectionId = result.connection.id;
  const credentials = one('SELECT credentials_enc FROM connections WHERE id = ?', connectionId).credentials_enc;
  const persistent = path.join(dataDir, 'plugin-data/github/marker.txt');
  fs.writeFileSync(persistent, 'existing-plugin-data');
  await plugins.setEnabled('github', false);
  const settings = one('SELECT settings_enc FROM plugins WHERE id = ?', 'github').settings_enc;
  fs.rmSync(path.join(dataDir, 'plugins/github'), { recursive: true });
  await plugins.reload(['github']);
  assert.equal(plugins.service('github'), undefined);
  assert.equal(toView(one('SELECT * FROM connections WHERE id = ?', connectionId)).status, 'unavailable');
  installFixturePlugins(dataDir, ['github']);
  await plugins.reload(['github']);
  assert.equal(plugins.get('github').status, 'disabled');
  assert.equal(one('SELECT settings_enc FROM plugins WHERE id = ?', 'github').settings_enc, settings);
  assert.equal(one('SELECT credentials_enc FROM connections WHERE id = ?', connectionId).credentials_enc, credentials);
  assert.deepEqual(plugins.settingsForAdmin('github').secretsSet, ['clientSecret']);
  assert.equal(plugins.settingsForAdmin('github').values.clientId, 'existing-client');
  assert.equal(fs.readFileSync(persistent, 'utf8'), 'existing-plugin-data');
  await plugins.setEnabled('github', true);
  assert.equal(plugins.get('github').status, 'active');
  assert.equal(loadConnection(user.id, connectionId).conn.credentials.token, 'existing-pat');
  assert.equal(toView(one('SELECT * FROM connections WHERE id = ?', connectionId)).status, 'ok');
});
