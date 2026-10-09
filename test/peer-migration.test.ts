import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-peer-migration-'));
process.env.SWITCHBOARD_DATA_DIR = dataDir;
const old = new DatabaseSync(path.join(dataDir, 'switchboard.db'));
old.exec(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/pre-peer-schema.sql'), 'utf8'));
old.exec(`
  INSERT INTO users(id, username, role, created_at) VALUES ('admin', 'admin', 'admin', 1), ('other', 'other', 'user', 2);
  INSERT INTO satellites(id, name, owner_user_id, token_hash, created_at, updated_at) VALUES ('sat_old', 'Laptop', 'admin', 'old-hash', 3, 3);
  INSERT INTO satellite_users VALUES ('sat_old', 'admin', 3), ('sat_old', 'other', 3);
  INSERT INTO upstreams(id, name, url, token_enc, enabled, created_at, updated_at) VALUES ('upstream_old', 'Laptop', 'https://example.com', 'encrypted-device-token', 0, 4, 4);
  INSERT INTO connections(id, user_id, service_id, method_id, name, config_enc, credentials_enc, satellite_id, remote_connection_id, created_at, updated_at)
    VALUES ('local', 'admin', 'http', 'token', 'local', 'encrypted-config', 'encrypted-secret', NULL, NULL, 5, 5),
    ('imported', 'admin', 'sat/sat_old/http', 'shared', 'imported', NULL, NULL, 'sat_old', 'remote', 5, 5);
  INSERT INTO connection_upstream_shares VALUES ('upstream_old', 'local');
  INSERT INTO saved_calls(id, user_id, connection_id, name, method, url, created_at, updated_at) VALUES ('saved', 'admin', 'imported', 'saved', 'GET', '/', 6, 6);
  INSERT INTO audit_log(user_id, created_at, source, service_id, upstream_id, upstream_user_id) VALUES ('admin', 7, 'call', 'sat/sat_old/http', 'upstream_old', 'remote-user');
  INSERT INTO instance_settings VALUES ('upstream-bootstrap', 'done');
  INSERT INTO plugins(id, enabled, settings_enc) VALUES ('switchboard', 1, 'encrypted-settings');
`);
old.close();
const database = await import('../server/db.ts');
after(() => { database.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('pre-peer migration preserves IDs, encrypted data, grants, access and saved calls without reverse grants', () => {
  database.initDb();
  const { one, all } = database;
  assert.equal(one('SELECT direction FROM peers WHERE id = ?', 'sat_old').direction, 'incoming');
  const outgoing = one('SELECT * FROM peers WHERE id = ?', 'upstream_old');
  assert.equal(outgoing.direction, 'outgoing'); assert.equal(outgoing.disabled, 1); assert.equal(outgoing.token_enc, 'encrypted-device-token');
  assert.notEqual(outgoing.name, 'Laptop', 'name collision resolved without merging identities');
  assert.deepEqual(all('SELECT peer_id, connection_id FROM connection_peer_shares').map(r => ({ ...r })), [{ peer_id: 'upstream_old', connection_id: 'local' }]);
  assert.deepEqual(all('SELECT user_id FROM peer_users WHERE peer_id = ? ORDER BY user_id', 'sat_old').map(r => r.user_id), ['admin', 'other']);
  assert.equal(one('SELECT COUNT(*) AS n FROM connection_peer_shares WHERE peer_id = ?', 'sat_old').n, 0);
  assert.equal(one('SELECT connection_id FROM saved_calls WHERE id = ?', 'saved').connection_id, 'imported');
  assert.equal(one('SELECT service_id FROM connections WHERE id = ?', 'imported').service_id, 'peer/sat_old/http');
  assert.equal(one('SELECT credentials_enc FROM connections WHERE id = ?', 'local').credentials_enc, 'encrypted-secret');
  assert.equal(one('SELECT peer_user_id FROM audit_log').peer_user_id, 'remote-user');
  assert.equal(one('SELECT enabled FROM plugins WHERE id = ?', 'switchboard').enabled, 0);
  assert.equal(one('SELECT settings_enc FROM plugins WHERE id = ?', 'switchboard').settings_enc, 'encrypted-settings');
  assert.equal(one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upstreams'"), undefined);
  assert.deepEqual(all('PRAGMA foreign_key_check'), []);
  const version = one('PRAGMA user_version').user_version;
  database.db.close(); database.initDb();
  assert.equal(one('PRAGMA user_version').user_version, version);
  assert.equal(one('SELECT COUNT(*) AS n FROM connection_peer_shares').n, 1);
});
