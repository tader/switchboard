import { all, now, one, run } from './db.ts';
import { hashPassword, randomId, randomToken, sha256, verifyPassword } from './crypto.ts';
import { config } from './config.ts';
import { badRequest, notFound } from './http.ts';
import { connectionChanged } from './connection-events.ts';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  hasPassword: boolean;
  createdAt: number;
}

/** Prefix of API tokens. Tokens from before the rename to Switchboard start with "hub_". */
export const TOKEN_PREFIX = 'swb_';
export const isApiToken = (s: string | undefined): s is string => !!s && (s.startsWith(TOKEN_PREFIX) || s.startsWith('hub_'));

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  connectionIds: string[] | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  /** "mcp" for tokens an MCP client got through OAuth: only valid at /mcp. */
  audience: string | null;
  /** The app that got the token through OAuth, if any. */
  clientName: string | null;
}

const toUser = (r: any): User => ({
  id: r.id,
  username: r.username,
  role: r.role,
  disabled: !!r.disabled,
  hasPassword: !!r.password_hash,
  createdAt: r.created_at,
});

const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/;

export function listUsers(): (User & { connections: number })[] {
  return all(
    `SELECT u.*, (SELECT COUNT(*) FROM connections c WHERE c.user_id = u.id) AS connections
     FROM users u WHERE COALESCE(u.peer_shadow, 0) = 0 ORDER BY u.username COLLATE NOCASE`,
  ).map((r) => ({ ...toUser(r), connections: r.connections }));
}


export function getUser(id: string): User | undefined {
  const r = one('SELECT * FROM users WHERE id = ?', id);
  return r && toUser(r);
}

export function createUser(username: string, role: Role): User {
  username = username.trim();
  if (!USERNAME.test(username)) throw badRequest('Usernames may contain letters, digits, ".", "_", "@" and "-"');
  if (one('SELECT 1 FROM users WHERE username = ?', username)) throw badRequest('That username is taken');
  const id = randomId('u');
  run('INSERT INTO users (id, username, role, created_at) VALUES (?, ?, ?, ?)', id, username, role, now());
  return getUser(id)!;
}

export function updateUser(id: string, patch: { role?: Role; disabled?: boolean; username?: string }) {
  const user = getUser(id);
  if (!user) throw notFound();
  if (patch.username !== undefined && patch.username !== user.username) {
    if (!USERNAME.test(patch.username)) throw badRequest('Invalid username');
    if (one('SELECT 1 FROM users WHERE username = ? AND id != ?', patch.username, id)) throw badRequest('That username is taken');
    run('UPDATE users SET username = ? WHERE id = ?', patch.username, id);
  }
  const demoting = (patch.role === 'user' || patch.disabled) && user.role === 'admin';
  if (demoting && activeAdminCount(id) === 0) throw badRequest('At least one active administrator is required');
  if (patch.role) run('UPDATE users SET role = ? WHERE id = ?', patch.role, id);
  if (patch.disabled !== undefined) {
    run('UPDATE users SET disabled = ? WHERE id = ?', patch.disabled ? 1 : 0, id);
    if (patch.disabled) { run('DELETE FROM sessions WHERE user_id = ?', id); connectionChanged(); }
  }
  return getUser(id)!;
}

function activeAdminCount(excludeId: string) {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL AND id != ?`,
    excludeId,
  )!.n;
}

export async function deleteUser(id: string) {
  const user = getUser(id);
  if (!user) throw notFound();
  if (user.role === 'admin' && activeAdminCount(id) === 0) throw badRequest('At least one active administrator is required');
  connectionChanged();
  run('DELETE FROM users WHERE id = ?', id);
}

// --- passwords & sessions ---

export function setPassword(userId: string, password: string) {
  if (password.length < 8) throw badRequest('Use at least 8 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), userId);
}

export function checkLogin(username: string, password: string): User | undefined {
  const r = one('SELECT * FROM users WHERE username = ?', username.trim());
  // Hash anyway so timing does not reveal whether the user exists.
  const ok = verifyPassword(password, r?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!r || !ok || r.disabled) return undefined;
  return toUser(r);
}

export function createSession(userId: string): string {
  const token = randomToken();
  run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, now() + config.sessionTtlSecs * 1000, now(),
  );
  return token;
}

export function sessionUser(token: string): User | undefined {
  const r = one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    sha256(token), now(),
  );
  return r && toUser(r);
}

export function deleteSession(token: string) {
  run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function deleteOtherSessions(userId: string, keepToken?: string) {
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepToken ? sha256(keepToken) : '');
}

// --- invites (one-time links to set a password) ---

export function createInvite(userId: string, validHours = 72): { url: string; expiresAt: number } {
  const token = randomToken();
  const expiresAt = now() + validHours * 3600_000;
  run('DELETE FROM invites WHERE user_id = ?', userId);
  run('INSERT INTO invites (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', sha256(token), userId, expiresAt, now());
  return { url: `${config.publicUrl}/invite#${token}`, expiresAt };
}

export function inviteUser(token: string): User | undefined {
  const r = one(
    `SELECT u.* FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.expires_at > ?`,
    sha256(token), now(),
  );
  return r && toUser(r);
}

export function acceptInvite(token: string, password: string): User {
  const user = inviteUser(token);
  if (!user) throw badRequest('This link is invalid or has expired');
  setPassword(user.id, password);
  run('DELETE FROM invites WHERE user_id = ?', user.id);
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  run('UPDATE users SET disabled = 0 WHERE id = ?', user.id);
  return getUser(user.id)!;
}

export function pendingInvites(): Map<string, number> {
  return new Map(all('SELECT user_id, expires_at FROM invites WHERE expires_at > ?', now()).map((r) => [r.user_id, r.expires_at]));
}

/** On start: make sure an administrator can sign in, otherwise print a setup link. */
export function ensureAdmin(): string | undefined {
  const ready = one(`SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL`);
  if (ready) return;
  let admin = one('SELECT * FROM users WHERE username = ?', config.adminUsername);
  if (!admin) admin = { id: createUser(config.adminUsername, 'admin').id };
  run(`UPDATE users SET role = 'admin', disabled = 0 WHERE id = ?`, admin.id);
  return createInvite(admin.id, 24).url;
}

// --- API tokens ---

const toToken = (r: any): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  connectionIds: r.connection_ids ? JSON.parse(r.connection_ids) : null,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  audience: r.audience ?? null,
  clientName: r.client_name ?? null,
});

export function listTokens(userId: string): ApiToken[] {
  return all('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', userId).map(toToken);
}

export function createToken(
  userId: string,
  name: string,
  connectionIds: string[] | null,
  expiresInDays?: number | null,
  opts: { audience?: string | null; clientName?: string | null } = {},
) {
  name = name.trim();
  if (!name) throw badRequest('Give the token a name');
  const secret = `${TOKEN_PREFIX}${randomToken(24)}`;
  const id = randomId('t');
  const expiresAt = expiresInDays ? now() + expiresInDays * 86400_000 : null;
  run(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, connection_ids, created_at, expires_at, audience, client_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, name, sha256(secret), secret.slice(0, 10), connectionIds ? JSON.stringify(connectionIds) : null, now(), expiresAt, opts.audience ?? null, opts.clientName ?? null,
  );
  return { token: toToken(one('SELECT * FROM api_tokens WHERE id = ?', id)), secret };
}

export function updateToken(userId: string, id: string, patch: { name?: string; connectionIds?: string[] | null }) {
  if (!one('SELECT 1 FROM api_tokens WHERE id = ? AND user_id = ?', id, userId)) throw notFound();
  if (patch.name !== undefined) run('UPDATE api_tokens SET name = ? WHERE id = ?', patch.name.trim(), id);
  if (patch.connectionIds !== undefined) {
    run('UPDATE api_tokens SET connection_ids = ? WHERE id = ?', patch.connectionIds ? JSON.stringify(patch.connectionIds) : null, id);
  }
  return toToken(one('SELECT * FROM api_tokens WHERE id = ?', id));
}

export function deleteToken(userId: string, id: string) {
  run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId);
}

export function tokenUser(secret: string): { user: User; token: ApiToken } | undefined {
  const r = one('SELECT * FROM api_tokens WHERE token_hash = ?', sha256(secret));
  if (!r || (r.expires_at && r.expires_at < now())) return;
  const user = getUser(r.user_id);
  if (!user || user.disabled) return;
  // Avoid a write per request.
  if (!r.last_used_at || now() - r.last_used_at > 60_000) run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), r.id);
  return { user, token: toToken(r) };
}
