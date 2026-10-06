import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export let db: DatabaseSync;

const migrations: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    connection_ids TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER
  );
  CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    settings_enc TEXT,
    installed_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    method_id TEXT NOT NULL,
    name TEXT NOT NULL,
    account_id TEXT,
    account_label TEXT,
    account_avatar TEXT,
    config_enc TEXT,
    credentials_enc TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    status_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (user_id, name)
  );
  CREATE TABLE connect_flows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    method_id TEXT NOT NULL,
    connection_id TEXT,
    name TEXT,
    config_enc TEXT,
    pending_enc TEXT,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE saved_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id TEXT,
    name TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    path_params TEXT,
    query TEXT,
    headers TEXT,
    body TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    token_name TEXT NOT NULL,
    connection_ids TEXT,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    connection_id TEXT,
    connection_name TEXT,
    service_id TEXT,
    token_id TEXT,
    token_name TEXT,
    saved_call TEXT,
    method TEXT,
    url TEXT,
    host TEXT,
    status INTEGER,
    duration_ms INTEGER,
    request_size INTEGER,
    response_size INTEGER,
    response_type TEXT,
    retried INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    ip TEXT,
    user_agent TEXT,
    request_headers TEXT,
    request_body TEXT
  );
  CREATE INDEX audit_user_time ON audit_log (user_id, created_at DESC);
  CREATE INDEX audit_user_connection ON audit_log (user_id, connection_id, created_at DESC);
  CREATE INDEX audit_user_token ON audit_log (user_id, token_id, created_at DESC);
  `,
  `
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  ALTER TABLE api_tokens ADD COLUMN audience TEXT;
  ALTER TABLE api_tokens ADD COLUMN client_name TEXT;
  ALTER TABLE oauth_codes ADD COLUMN resource TEXT;
  ALTER TABLE oauth_codes ADD COLUMN client_name TEXT;
  `,
  // The hub-to-hub plugin and service were renamed with the app, from "hub" to "switchboard".
  `
  UPDATE connections SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE connect_flows SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE audit_log SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE plugins SET id = 'switchboard' WHERE id = 'hub' AND NOT EXISTS (SELECT 1 FROM plugins WHERE id = 'switchboard');
  `,
];

export function initDb() {
  // Data from before the rename to Switchboard is moved over once.
  const file = path.join(config.dataDir, 'switchboard.db');
  const legacy = path.join(config.dataDir, 'hub.db');
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, file + ext);
  }
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < migrations.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const now = () => Date.now();

export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
