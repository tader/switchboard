import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServiceDefinition } from '../server/plugins/api.ts';
import type { User } from '../server/users.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-kind-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
const database = await import('../server/db.ts');
const { initKey } = await import('../server/crypto.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const { startConnect, listServices, loadConnection, toView } = await import('../server/connections.ts');
database.initDb();
initKey();
const user: User = { id: 'owner', username: 'owner', role: 'user', disabled: false, hasPassword: false, createdAt: 1 };
database.run('INSERT INTO users (id, username, role, created_at) VALUES (?, ?, ?, ?)', user.id, user.username, user.role, 1);

after(() => {
  database.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP kind survives reconnect, plugin removal, and database restart', async () => {
  const service: ServiceDefinition = {
    id: 'test-mcp', name: 'Test MCP', kind: 'mcp',
    authMethods: [{ id: 'none', name: 'None', connect: () => ({ credentials: {} }), authorize: () => {} }],
  };
  plugins.services.set(service.id, { service, pluginId: 'test' });
  assert.equal(listServices().find(s => s.id === service.id)?.kind, 'mcp');
  const result = await startConnect(user, { service: service.id });
  assert.equal(result.status, 'connected');
  if (result.status !== 'connected') throw new Error('Expected connection');
  const id = result.connection.id;
  assert.equal(result.connection.kind, 'mcp');
  assert.equal(loadConnection(user.id, id).conn.kind, 'mcp');
  const reconnect = await startConnect(user, { service: service.id, connection: id });
  assert.equal(reconnect.status, 'connected');
  assert.equal(database.one('SELECT kind FROM connections WHERE id = ?', id).kind, 'mcp');
  plugins.services.delete(service.id);
  database.db.close();
  database.initDb();
  const view = toView(database.one('SELECT * FROM connections WHERE id = ?', id));
  assert.equal(view.kind, 'mcp');
  assert.equal(view.status, 'unavailable');
  assert.throws(() => database.run('UPDATE connections SET kind = ? WHERE id = ?', 'invalid', id), /CHECK constraint/);
});
