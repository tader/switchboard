-- Frozen schema before peer protocol 3.

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
  

  UPDATE connections SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE connect_flows SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE audit_log SET service_id = 'switchboard' WHERE service_id = 'hub';
  UPDATE plugins SET id = 'switchboard' WHERE id = 'hub' AND NOT EXISTS (SELECT 1 FROM plugins WHERE id = 'switchboard');
  

  ALTER TABLE connect_flows ADD COLUMN redirect_uri TEXT;
  ALTER TABLE connections ADD COLUMN redirect_uri TEXT;
  

  CREATE TABLE satellites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    catalog_json TEXT,
    catalog_version TEXT,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE satellite_users (
    satellite_id TEXT NOT NULL REFERENCES satellites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (satellite_id, user_id)
  );
  

  ALTER TABLE users ADD COLUMN satellite_shadow INTEGER NOT NULL DEFAULT 0;
  

  ALTER TABLE connections ADD COLUMN satellite_id TEXT REFERENCES satellites(id) ON DELETE RESTRICT;
  ALTER TABLE connections ADD COLUMN remote_connection_id TEXT;
  ALTER TABLE connect_flows ADD COLUMN satellite_id TEXT REFERENCES satellites(id) ON DELETE CASCADE;
  ALTER TABLE connect_flows ADD COLUMN remote_flow_id TEXT;
  CREATE INDEX connections_satellite ON connections (satellite_id);
  
ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'http' CHECK (kind IN ('http', 'mcp'));

  ALTER TABLE audit_log ADD COLUMN mcp_operation TEXT;
  ALTER TABLE audit_log ADD COLUMN mcp_target TEXT;
  ALTER TABLE audit_log ADD COLUMN mcp_outcome TEXT;
  

  ALTER TABLE saved_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'http' CHECK (kind IN ('http', 'mcp'));
  ALTER TABLE saved_calls ADD COLUMN mcp_request TEXT;
  

  CREATE TABLE instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE upstreams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, url TEXT NOT NULL,
    token_enc TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE connection_upstream_shares (
    upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    PRIMARY KEY (upstream_id, connection_id)
  );
  ALTER TABLE audit_log ADD COLUMN upstream_id TEXT;
  ALTER TABLE audit_log ADD COLUMN upstream_user_id TEXT;
  
ALTER TABLE satellites ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 14;
